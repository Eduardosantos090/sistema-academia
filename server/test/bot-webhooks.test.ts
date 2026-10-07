import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decide, normalizeText } from '../src/modules/bot/engine.js';
import { signValue } from '../src/lib/secrets.js';
import { Agent, bootstrapPlatform, createCustomer, createOrg, json, orgToday, setupApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let org: Awaited<ReturnType<typeof createOrg>>;
let hookId: string;
let secret: string;
let customerId: string;

function signed(body: object, s = secret, ts = Math.floor(Date.now() / 1000).toString()) {
  const raw = JSON.stringify(body);
  return {
    payload: raw,
    headers: {
      'content-type': 'application/json',
      'x-venceu-timestamp': ts,
      'x-venceu-signature': `sha256=${createHmac('sha256', s).update(`${ts}.${raw}`).digest('hex')}`,
    },
  };
}

let msgSeq = 0;
async function inbound(text: string, from = '5511955554444', id = `msg-${Date.now()}-${msgSeq++}`) {
  const r = await ctx.app.inject({ method: 'POST', url: `/api/webhooks/inbound/${hookId}`, ...signed({ from, text, id }) });
  expect(r.statusCode).toBe(200);
  return r.json() as { replies: string[]; intent: string | null };
}

beforeAll(async () => {
  ctx = await setupApp();
  const platform = (await bootstrapPlatform(ctx)).agent;
  org = await createOrg(ctx, platform, 'Academia Bot');
  await org.owner.patch('/api/settings/organization', { pixKey: 'pix@academia.test' });
  const r = await org.owner.put('/api/settings/whatsapp', { mode: 'webhook', webhookUrl: 'https://hooks.exemplo.com/x' });
  secret = r.json().webhookSecret;
  hookId = (await ctx.owner.query('select webhook_id from organizations where id = $1', [org.orgId])).rows[0].webhook_id;
  // Celular cadastrado com 9º dígito; o WhatsApp pode enviar sem ele.
  customerId = await createCustomer(org.owner, { name: 'Bruna Bot', phone: '(11) 95555-4444' });
  await org.owner.post('/api/charges', { customerId, description: 'Mensalidade', amountCents: 15000, dueDate: await orgToday(ctx, org.orgId, -2) });
});
afterAll(() => ctx.close());

describe('webhook de entrada', () => {
  it('recusa sem assinatura, com assinatura errada, antiga ou endereço inexistente', async () => {
    const body = { from: '5511955554444', text: 'oi' };
    const noSig = await ctx.app.inject({ method: 'POST', url: `/api/webhooks/inbound/${hookId}`, payload: body });
    expect(noSig.statusCode).toBe(403);
    const bad = await ctx.app.inject({ method: 'POST', url: `/api/webhooks/inbound/${hookId}`, ...signed(body, 'segredo-errado') });
    expect(bad.statusCode).toBe(403);
    const old = await ctx.app.inject({ method: 'POST', url: `/api/webhooks/inbound/${hookId}`, ...signed(body, secret, String(Math.floor(Date.now() / 1000) - 3600)) });
    expect(old.statusCode).toBe(403);
    const other = await ctx.app.inject({ method: 'POST', url: `/api/webhooks/inbound/${'a'.repeat(64)}`, ...signed(body) });
    expect(other.statusCode).toBe(403);
  });

  it('webhook da Meta exige assinatura com o App Secret e token de verificação', async () => {
    const get = await ctx.app.inject({ method: 'GET', url: `/api/webhooks/whatsapp/${hookId}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=123` });
    expect(get.statusCode).toBe(403);
    const post = await ctx.app.inject({ method: 'POST', url: `/api/webhooks/whatsapp/${hookId}`, payload: { entry: [] }, headers: { 'x-hub-signature-256': 'sha256=00' } });
    expect(post.statusCode).toBe(403);
  });

  it('menu, vencimentos (com e sem nono dígito) e dados de pagamento', async () => {
    const menu = await inbound('Oi');
    expect(menu.intent).toBe('menu');
    expect(menu.replies[0]).toContain('Bruna');
    const v = await inbound('1', '551155554444'); // sem o 9
    expect(v.intent).toBe('vencimentos');
    expect(v.replies[0]).toContain('R$ 150,00');
    expect(v.replies[0]).toContain('em atraso há 2 dia(s)');
    const p = await inbound('qual a chave pix?');
    expect(p.replies[0]).toContain('pix@academia.test');
  });

  it('"já paguei" marca a cobrança para conferência; reentrega não duplica', async () => {
    const r1 = await inbound('Já paguei!', '5511955554444', 'msg-123');
    expect(r1.intent).toBe('ja_paguei');
    const r2 = await inbound('Já paguei!', '5511955554444', 'msg-123');
    expect(r2.replies).toEqual([]);
    const toConfirm = json(await org.owner.get('/api/charges?filter=a_conferir'));
    expect(toConfirm.total).toBe(1);
  });

  it('pedir atendente silencia o bot até a equipe devolver a conversa', async () => {
    const r = await inbound('quero falar com um atendente');
    expect(r.intent).toBe('atendente');
    expect((await inbound('alô?')).replies).toEqual([]);
    const conv = json(await org.owner.get('/api/conversations?status=humano')).items[0];
    expect(conv.customerName).toBe('Bruna Bot');
    expect(conv.unread).toBeGreaterThan(0);
    const reply = await org.owner.post(`/api/conversations/${conv.id}/reply`, { text: 'Olá, Bruna! Sou a Carla.' });
    expect(reply.statusCode).toBe(200);
    expect(ctx.http.calls.at(-1)!.url).toBe('https://hooks.exemplo.com/x');
    expect((await org.owner.patch(`/api/conversations/${conv.id}`, { status: 'bot' })).statusCode).toBe(200);
    expect((await inbound('menu')).intent).toBe('menu');
  });

  it('SAIR desativa os avisos por WhatsApp (opt-out)', async () => {
    const r = await inbound('SAIR');
    expect(r.intent).toBe('sair');
    const c = json(await org.owner.get(`/api/customers/${customerId}`));
    expect(c.whatsappOptIn).toBe(false);
    const send = await org.owner.post(`/api/charges/${c.charges[0].id}/send`, { channel: 'whatsapp' });
    expect(send.statusCode).toBe(409);
    await inbound('receber avisos');
    expect(json(await org.owner.get(`/api/customers/${customerId}`)).whatsappOptIn).toBe(true);
  });

  it('número desconhecido não recebe dados de ninguém', async () => {
    const r = await inbound('1', '5521911112222');
    expect(r.replies[0]).toContain('Não encontrei um cadastro');
  });
});

describe('lógica do assistente', () => {
  const orgRow = { id: 'x', name: 'Studio', slug: 's', pix_key: null, payment_instructions: null, contact_phone: null, bot_enabled: true, bot_greeting: null, today: '2026-10-10' };
  it('normaliza acentos e pontuação', () => {
    expect(normalizeText('  Já PAGUEI!!! ')).toBe('ja paguei');
  });
  it('respostas personalizadas têm prioridade', () => {
    const d = decide(orgRow, [{ id: '1', name: 'Ana' }], [], [{ keywords: ['horário'], answer: 'Abrimos às 6h.' }], 'qual o horario de vocês?');
    expect(d).toMatchObject({ intent: 'faq', replies: ['Abrimos às 6h.'] });
  });
  it('sem dados de pagamento, encaminha para atendente', () => {
    expect(decide(orgRow, [], [], [], '2').replies[0]).toContain('atendente');
  });
});

describe('descadastro de e-mail', () => {
  it('link assinado funciona; adulterado não', async () => {
    const anon = new Agent(ctx);
    const bad = await anon.post('/api/public/unsubscribe', { token: `${customerId}.${'A'.repeat(32)}` });
    expect(bad.statusCode).toBe(400);
    const sig = signValue(ctx.deps.config.secretsKey, 'unsubscribe', customerId);
    const ok = await anon.post('/api/public/unsubscribe', { token: `${customerId}.${sig}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().organization).toBe('Academia Bot');
    expect(json(await org.owner.get(`/api/customers/${customerId}`)).emailOptIn).toBe(false);
  });
});

describe('pedido de acesso pelo site', () => {
  it('cria pedido, plataforma aprova e o responsável recebe convite', async () => {
    const anon = new Agent(ctx);
    const r = await anon.post('/api/public/access-request', { name: 'Fulana', businessName: 'Clínica Sorriso', segment: 'clinica', email: 'fulana@clinica.test', consent: true });
    expect(r.statusCode).toBe(200);
    expect((await anon.post('/api/public/access-request', { name: 'F', businessName: 'X', email: 'x@x.test', consent: false })).statusCode).toBe(422);
    const platform = (await bootstrapPlatform(ctx)).agent;
    const list = json(await platform.get('/api/platform/requests'));
    const req = list.items.find((x: { email: string }) => x.email === 'fulana@clinica.test');
    const ap = await platform.post(`/api/platform/requests/${req.id}/approve`, {});
    expect(ap.statusCode).toBe(200);
    expect(ctx.mailer.outbox.some((m) => m.to === 'fulana@clinica.test' && m.text.includes('/convite#token='))).toBe(true);
    const rules = await ctx.owner.query('select count(*)::int as n from reminder_rules where organization_id = $1', [ap.json().id]);
    expect(rules.rows[0].n).toBe(4);
  });
});
