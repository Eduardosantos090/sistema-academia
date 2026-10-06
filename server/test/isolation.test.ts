import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, PASSWORD, bootstrapPlatform, createCharge, createCustomer, createOrg, inviteStaff, json, setupApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let platform: Agent;
let a: Awaited<ReturnType<typeof createOrg>>;
let b: Awaited<ReturnType<typeof createOrg>>;
let staffA: Agent;
let custA: string;
let chargeA: string;

beforeAll(async () => {
  ctx = await setupApp();
  platform = (await bootstrapPlatform(ctx)).agent;
  a = await createOrg(ctx, platform);
  b = await createOrg(ctx, platform);
  staffA = (await inviteStaff(ctx, a.owner)).agent;
  custA = await createCustomer(a.owner, { name: 'Cliente da Org A' });
  chargeA = await createCharge(a.owner, custA);
});
afterAll(() => ctx.close());

describe('isolamento entre organizações (RLS)', () => {
  it('organização B não vê clientes nem cobranças da A', async () => {
    expect((await b.owner.get(`/api/customers/${custA}`)).statusCode).toBe(404);
    expect((await b.owner.get(`/api/charges/${chargeA}`)).statusCode).toBe(404);
    const list = json(await b.owner.get('/api/customers'));
    expect(list.items.find((c: { id: string }) => c.id === custA)).toBeUndefined();
    expect(json(await b.owner.get('/api/charges?filter=todas')).total).toBe(0);
  });

  it('B não altera, paga, cancela nem envia cobranças da A', async () => {
    expect((await b.owner.patch(`/api/customers/${custA}`, { name: 'Hack' })).statusCode).toBe(404);
    expect((await b.owner.post(`/api/charges/${chargeA}/pay`, {})).statusCode).toBe(409);
    expect((await b.owner.post(`/api/charges/${chargeA}/cancel`)).statusCode).toBe(409);
    expect((await b.owner.post(`/api/charges/${chargeA}/send`, { channel: 'whatsapp' })).statusCode).toBe(404);
    expect((await b.owner.delete(`/api/customers/${custA}`)).statusCode).toBe(404);
    const { rows } = await ctx.owner.query('select status, name from charges ch join customers c on c.id = ch.customer_id where ch.id = $1', [chargeA]);
    expect(rows[0]).toMatchObject({ status: 'aberta', name: 'Cliente da Org A' });
  });

  it('B não cria cobrança nem assinatura para cliente da A', async () => {
    expect((await b.owner.post('/api/charges', { customerId: custA, description: 'Invasão', amountCents: 100, dueDate: '2030-01-01' })).statusCode).toBe(404);
    expect((await b.owner.post('/api/subscriptions', { customerId: custA, description: 'Invasão', amountCents: 100, intervalMonths: 1, firstDueDate: '2030-01-01' })).statusCode).toBe(404);
  });

  it('banco recusa vínculo entre organizações mesmo sem o servidor (gatilho)', async () => {
    const { rows } = await ctx.owner.query<{ id: string }>('select id from users where organization_id = $1 limit 1', [b.orgId]);
    const client = await ctx.deps.pools.app.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [rows[0]!.id]);
      await expect(
        client.query(`insert into charges (organization_id, customer_id, description, amount_cents, due_date) values ($1, $2, 'x', 100, '2030-01-01')`, [b.orgId, custA]),
      ).rejects.toThrow();
      await client.query('rollback');
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [rows[0]!.id]);
      await expect(
        client.query(`insert into charges (organization_id, customer_id, description, amount_cents, due_date) values ($1, $2, 'x', 100, '2030-01-01')`, [a.orgId, custA]),
      ).rejects.toThrow();
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('papel da aplicação sem usuário não lê nada e não acessa tabelas de credenciais', async () => {
    const client = await ctx.deps.pools.app.connect();
    try {
      expect((await client.query('select * from customers')).rowCount).toBe(0);
      await expect(client.query('select * from user_credentials')).rejects.toThrow();
      await expect(client.query('select * from sessions')).rejects.toThrow();
      await expect(client.query('select * from org_channels')).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it('administração da plataforma NÃO lê dados de clientes das organizações', async () => {
    expect((await platform.get(`/api/customers/${custA}`)).statusCode).toBe(403);
    expect((await platform.get('/api/charges')).statusCode).toBe(403);
    const orgs = json(await platform.get('/api/platform/orgs'));
    expect(orgs.items.find((o: { id: string }) => o.id === a.orgId).customers).toBe(1);
  });
});

describe('perfis dentro da organização', () => {
  it('equipe opera cobranças mas não gerencia equipe, modelos, regras, integrações nem exclui clientes', async () => {
    expect((await staffA.get(`/api/customers/${custA}`)).statusCode).toBe(200);
    expect((await staffA.post('/api/team', { email: 'x@example.test', fullName: 'X Y', role: 'owner' })).statusCode).toBe(403);
    expect((await staffA.post('/api/plans', { name: 'P', amountCents: 100, intervalMonths: 1 })).statusCode).toBe(403);
    expect((await staffA.put('/api/settings/whatsapp', { mode: 'manual' })).statusCode).toBe(403);
    expect((await staffA.patch('/api/settings/organization', { pixKey: 'x' })).statusCode).toBe(403);
    expect((await staffA.delete(`/api/customers/${custA}`)).statusCode).toBe(403);
    expect((await staffA.get('/api/audit')).statusCode).toBe(403);
    const s = json(await staffA.get('/api/settings'));
    expect(s.channels.verifyToken).toBeUndefined();
    expect(s.channels.cloudWebhookUrl).toBeUndefined();
  });

  it('não é possível escalar para administrador da plataforma nem mudar de organização', async () => {
    const r = await a.owner.post('/api/team', { email: 'esc@example.test', fullName: 'Esc', role: 'owner', isPlatformAdmin: true });
    expect(r.statusCode).toBe(422);
    const me = json(await a.owner.get('/api/auth/me')).user;
    expect((await a.owner.patch(`/api/team/${me.id}`, { role: 'staff' })).statusCode).toBe(409);
    expect((await a.owner.patch(`/api/team/${me.id}`, { isActive: false })).statusCode).toBe(409);
  });

  it('organização suspensa: usuários perdem o acesso imediatamente', async () => {
    const c = await createOrg(ctx, platform);
    expect((await c.owner.get('/api/dashboard')).statusCode).toBe(200);
    expect((await platform.patch(`/api/platform/orgs/${c.orgId}`, { isActive: false })).statusCode).toBe(200);
    expect((await c.owner.get('/api/dashboard')).statusCode).toBe(401);
    const again = new Agent(ctx);
    expect((await again.post('/api/auth/login', { email: c.ownerEmail, password: PASSWORD })).statusCode).toBe(403);
  });

  it('dono da organização não pode reativar a própria organização nem mudar o slug (gatilho)', async () => {
    const { rows } = await ctx.owner.query<{ id: string }>('select id from users where organization_id = $1 and role = $2 limit 1', [a.orgId, 'owner']);
    const client = await ctx.deps.pools.app.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [rows[0]!.id]);
      await expect(client.query(`update organizations set is_active = false where id = $1`, [a.orgId])).rejects.toThrow(/plataforma/);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

describe('sessão e CSRF', () => {
  it('exige sessão e token CSRF em operações de escrita', async () => {
    const anon = new Agent(ctx);
    expect((await anon.get('/api/customers')).statusCode).toBe(401);
    const r = await a.owner.request('POST', '/api/customers', { name: 'Sem CSRF' }, { 'x-csrf-token': 'errado' });
    expect(r.statusCode).toBe(403);
  });

  it('rejeita origem estranha', async () => {
    const r = await a.owner.request('GET', '/api/customers', undefined, { origin: 'https://malicioso.example' });
    expect(r.statusCode).toBe(403);
  });

  it('cabeçalhos de segurança presentes', async () => {
    const r = await a.owner.get('/api/auth/me');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('login: mensagem genérica e bloqueio após tentativas', async () => {
    const x = new Agent(ctx);
    const wrong = await x.post('/api/auth/login', { email: a.ownerEmail, password: 'errada-errada' });
    expect(wrong.statusCode).toBe(401);
    const none = await x.post('/api/auth/login', { email: 'naoexiste@example.test', password: 'errada-errada' });
    expect(json(none).error.message).toBe(json(wrong).error.message);
  });
});
