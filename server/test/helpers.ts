import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createDeps } from '../src/deps.js';
import { buildApp } from '../src/app.js';
import { MemoryMailer, type MailMessage, type OrgSmtp } from '../src/lib/mailer.js';
import type { Deps } from '../src/lib/context.js';
import type { HttpRequest, HttpResult } from '../src/lib/http.js';
import { newToken, sha256 } from '../src/lib/crypto.js';
import { TEST_ENV } from './env.js';

/** Cliente HTTP de saída falso: registra as chamadas e devolve respostas configuráveis. */
export class FakeHttp {
  calls: { url: string; req: HttpRequest }[] = [];
  respond: (url: string, req: HttpRequest) => HttpResult = () => ({ status: 200, body: JSON.stringify({ messages: [{ id: 'wamid.TESTE' }] }) });
  fetch = async (url: string, req: HttpRequest) => {
    this.calls.push({ url, req });
    return this.respond(url, req);
  };
}

export interface TestCtx {
  app: FastifyInstance;
  deps: Deps;
  mailer: MemoryMailer;
  /** E-mails enviados pelas contas próprias das organizações. */
  orgOutbox: { smtp: OrgSmtp; msg: MailMessage }[];
  http: FakeHttp;
  owner: pg.Pool;
  close: () => Promise<void>;
}

export async function setupApp(extra: Record<string, string> = {}): Promise<TestCtx> {
  const config = loadConfig({ ...process.env, ...TEST_ENV, ...extra });
  const mailer = new MemoryMailer();
  const http = new FakeHttp();
  const orgOutbox: TestCtx['orgOutbox'] = [];
  const orgMailer = (smtp: OrgSmtp) => ({
    send: async (msg: MailMessage) => {
      orgOutbox.push({ smtp, msg });
    },
  });
  const deps = await createDeps(config, { mailer, orgMailer, fetch: http.fetch });
  const app = await buildApp(deps);
  await app.ready();
  return {
    app, deps, mailer, orgOutbox, http, owner: deps.pools.owner,
    close: async () => {
      await app.close();
      await deps.pools.app.end();
      await deps.pools.owner.end();
    },
  };
}

let ipCounter = 1;

/** Cliente HTTP que mantém cookie de sessão e token CSRF, como o navegador. */
export class Agent {
  cookie: string | null = null;
  csrf: string | null = null;
  readonly ip = `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  constructor(private readonly ctx: TestCtx) {}

  async request(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && !('x-csrf-token' in extraHeaders)) headers['x-csrf-token'] = this.csrf;
    const res = await this.ctx.app.inject({
      method: method as 'GET', url, headers, remoteAddress: this.ip,
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    const set = res.cookies.find((c) => c.name === 'vc_session');
    if (set) this.cookie = set.value ? `vc_session=${set.value}` : null;
    return res;
  }
  get(url: string) { return this.request('GET', url); }
  post(url: string, body: unknown = {}) { return this.request('POST', url, body); }
  patch(url: string, body: unknown = {}) { return this.request('PATCH', url, body); }
  put(url: string, body: unknown = {}) { return this.request('PUT', url, body); }
  delete(url: string) { return this.request('DELETE', url); }

  async login(email: string, password: string) {
    const res = await this.post('/api/auth/login', { email, password });
    if (res.statusCode !== 200) throw new Error(`login falhou (${res.statusCode}): ${res.body}`);
    this.csrf = res.json().csrfToken;
    return res;
  }
}

export const json = (r: LightMyRequestResponse) => r.json() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const PASSWORD = 'Senha-de-teste-123';
let seq = 0;
export const uniq = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

export function tokenFromMail(mailer: MemoryMailer, to: string): string {
  const msg = [...mailer.outbox].reverse().find((m) => m.to === to);
  const m = msg?.text.match(/#token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`nenhum token enviado para ${to}`);
  return m[1]!;
}

async function accept(ctx: TestCtx, email: string) {
  const agent = new Agent(ctx);
  const r = await agent.post('/api/auth/invite/accept', { token: tokenFromMail(ctx.mailer, email), password: PASSWORD });
  if (r.statusCode !== 200) throw new Error(r.body);
  await agent.login(email, PASSWORD);
  return agent;
}

/** Administrador da plataforma, criado como o script CLI faz. */
export async function bootstrapPlatform(ctx: TestCtx) {
  const email = `${uniq('plataforma')}@venceu.test`;
  const { rows } = await ctx.owner.query<{ id: string }>(
    "insert into users (email, full_name, is_platform_admin) values ($1, 'Plataforma Teste', true) returning id",
    [email],
  );
  const token = newToken();
  await ctx.owner.query("insert into invites (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')", [
    sha256(token), rows[0]!.id,
  ]);
  const agent = new Agent(ctx);
  const r = await agent.post('/api/auth/invite/accept', { token, password: PASSWORD });
  if (r.statusCode !== 200) throw new Error(r.body);
  await agent.login(email, PASSWORD);
  return { agent, email, id: rows[0]!.id };
}

/** Cria organização pela plataforma; o responsável aceita o convite e entra. */
export async function createOrg(ctx: TestCtx, platform: Agent, name = uniq('Academia')) {
  const ownerEmail = `${uniq('dono')}@example.test`;
  const r = await platform.post('/api/platform/orgs', { name, segment: 'academia', ownerName: 'Dono Teste', ownerEmail });
  if (r.statusCode !== 201) throw new Error(r.body);
  const orgId = r.json().id as string;
  const owner = await accept(ctx, ownerEmail);
  return { orgId, owner, ownerEmail };
}

export async function inviteStaff(ctx: TestCtx, owner: Agent, role: 'staff' | 'owner' = 'staff') {
  const email = `${uniq('equipe')}@example.test`;
  const r = await owner.post('/api/team', { email, fullName: 'Equipe Teste', role });
  if (r.statusCode !== 201) throw new Error(r.body);
  return { agent: await accept(ctx, email), id: r.json().id as string, email };
}

export function isoDate(offsetDays = 0) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  now.setDate(now.getDate() + offsetDays);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export async function createCustomer(agent: Agent, data: Record<string, unknown> = {}) {
  const r = await agent.post('/api/customers', { name: 'Cliente Fictício', phone: '(11) 98888-7777', email: `${uniq('cli')}@example.test`, ...data });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id as string;
}

export async function createCharge(agent: Agent, customerId: string, dueDate = isoDate(3), amountCents = 12990) {
  const r = await agent.post('/api/charges', { customerId, description: 'Mensalidade', amountCents, dueDate });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id as string;
}

/** Faz todas as organizações estarem "dentro do horário de envio" (independe da hora do teste). */
export async function openSendWindow(ctx: TestCtx, orgId: string) {
  const { rows } = await ctx.owner.query<{ h: number }>(`select extract(hour from now() at time zone 'America/Sao_Paulo')::int as h`);
  const h = rows[0]!.h;
  if (h < 6 || h >= 21) {
    // Fora da faixa permitida: usa um fuso em que agora seja horário comercial.
    await ctx.owner.query(`update organizations set timezone = 'Asia/Tokyo', send_hour = 6 where id = $1`, [orgId]);
    return false;
  }
  await ctx.owner.query('update organizations set send_hour = $2 where id = $1', [orgId, Math.max(6, Math.min(20, h))]);
  return true;
}

export async function orgToday(ctx: TestCtx, orgId: string, plus = 0) {
  const { rows } = await ctx.owner.query<{ d: string }>(`select to_char(app.org_today($1) + $2::int, 'YYYY-MM-DD') as d`, [orgId, plus]);
  return rows[0]!.d;
}
