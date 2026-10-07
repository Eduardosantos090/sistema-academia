import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pollOnlinePayments } from '../src/modules/payments/service.js';
import { collectIds } from '../src/modules/payments/routes.js';
import { bootstrapPlatform, createCharge, createCustomer, createOrg, inviteStaff, json, setupApp, type Agent, type TestCtx } from './helpers.js';
import type { HttpRequest } from '../src/lib/http.js';

let ctx: TestCtx;
let pixSeq = Date.now();
let platform: Agent;

/** AbacatePay simulada: guarda os PIX criados e a situação de cada um. */
class FakeAbacate {
  pix = new Map<string, { amount: number; status: string; devMode: boolean }>();
  validKeys = new Set(['abc_dev_CHAVEVALIDA123', 'abc_prod_OUTRACHAVE456']);
  handle(url: string, req: HttpRequest) {
    const auth = req.headers?.authorization ?? '';
    if (!this.validKeys.has(auth.replace(/^Bearer /, ''))) return { status: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    const u = new URL(url);
    if (u.pathname === '/v1/store/get') return ok({ id: 'store_1', name: 'Loja Teste' });
    if (u.pathname === '/v1/pixQrCode/create') {
      const b = JSON.parse(req.body!);
      const id = `pix_char_${++pixSeq}TESTE`;
      const devMode = auth.includes('abc_dev_');
      this.pix.set(id, { amount: b.amount, status: 'PENDING', devMode });
      return ok({
        id, amount: b.amount, status: 'PENDING', devMode, method: 'PIX', description: b.description,
        brCode: `00020101021226-PIX-${id}`, brCodeBase64: 'data:image/png;base64,iVBORw0KGgo=',
        expiresAt: new Date(Date.now() + b.expiresIn * 1000).toISOString(),
      });
    }
    const id = u.searchParams.get('id') ?? '';
    const p = this.pix.get(id);
    if (u.pathname === '/v1/pixQrCode/check') return p ? ok({ status: p.status, expiresAt: new Date(Date.now() + 3600_000).toISOString() }) : { status: 404, body: '{"error":"Not found"}' };
    if (u.pathname === '/v1/pixQrCode/simulate-payment' && p?.devMode) {
      p.status = 'PAID';
      return ok({ id, status: 'PAID' });
    }
    return { status: 404, body: '{"error":"Not found"}' };
  }
}
const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data, error: null }) });

let abacate: FakeAbacate;
beforeAll(async () => {
  ctx = await setupApp();
  platform = (await bootstrapPlatform(ctx)).agent;
});
beforeEach(() => {
  abacate = new FakeAbacate();
  ctx.http.respond = (url, req) => (url.startsWith('https://api.abacatepay.com/') ? abacate.handle(url, req) : { status: 200, body: '{"messages":[{"id":"x"}]}' });
});
afterAll(() => ctx.close());

async function setupOnlineOrg(key = 'abc_dev_CHAVEVALIDA123') {
  const o = await createOrg(ctx, platform);
  const r = await o.owner.put('/api/settings/payments', { enabled: true, apiKey: key });
  expect(r.statusCode).toBe(200);
  const s = json(await o.owner.get('/api/settings/payments'));
  const cid = await createCustomer(o.owner, { name: 'Paula Pagante', phone: '(11) 95555-1234' });
  const chargeId = await createCharge(o.owner, cid, undefined, 15000);
  const { rows } = await ctx.owner.query('select pay_token from charges where id = $1', [chargeId]);
  return { ...o, settings: s, customerId: cid, chargeId, token: rows[0].pay_token as string };
}

const abacateCalls = (path: string) => ctx.http.calls.filter((c) => c.url.startsWith(`https://api.abacatepay.com/v1${path}`));

describe('PIX automático (AbacatePay)', () => {
  it('somente o responsável configura; chave recusada não é salva; segredos não vazam', async () => {
    const { owner } = await createOrg(ctx, platform);
    const staff = (await inviteStaff(ctx, owner)).agent;
    expect((await staff.put('/api/settings/payments', { enabled: true, apiKey: 'abc_dev_CHAVEVALIDA123' })).statusCode).toBe(403);
    expect((await staff.get('/api/settings/payments')).statusCode).toBe(403);
    expect((await owner.put('/api/settings/payments', { enabled: true, apiKey: 'abc_dev_ERRADA00000' })).statusCode).toBe(422);
    expect(json(await owner.get('/api/settings/payments')).enabled).toBe(false);
    expect((await owner.put('/api/settings/payments', { enabled: true, apiKey: 'abc_dev_CHAVEVALIDA123' })).json().storeName).toBe('Loja Teste');
    const s = json(await owner.get('/api/settings/payments'));
    expect(s).toMatchObject({ enabled: true, testMode: true, keyHint: 'abc_dev_…A123' });
    expect(JSON.stringify(s)).not.toContain('CHAVEVALIDA');
    const enc = await ctx.owner.query('select abacate_api_key_enc from org_channels oc join users u on u.organization_id = oc.organization_id limit 1');
    expect(String(enc.rows[0]?.abacate_api_key_enc ?? '')).not.toContain('CHAVEVALIDA');
  });

  it('lembrete leva o link de pagamento; a página gera o PIX uma vez e reaproveita', async () => {
    const o = await setupOnlineOrg();
    const sr = await o.owner.post(`/api/charges/${o.chargeId}/send`, { channel: 'whatsapp' });
    expect(sr.statusCode).toBe(200);
    const send = sr.json();
    const msg = await ctx.owner.query('select body from messages where id = $1', [send.messageId]);
    expect(msg.rows[0].body).toContain(`/pagar/${o.token}`);

    const anon = new (await import('./helpers.js')).Agent(ctx);
    const p1 = json(await anon.get(`/api/pay/${o.token}`));
    expect(p1).toMatchObject({ status: 'aberta', amountCents: 15000, pix: { devMode: true } });
    expect(p1.pix.brCode).toContain('pix_char_');
    expect(JSON.stringify(p1)).not.toMatch(/Paula|95555/); // sem dados pessoais do cliente
    const p2 = json(await anon.get(`/api/pay/${o.token}`));
    expect(p2.pix.brCode).toBe(p1.pix.brCode);
    const created = abacateCalls('/pixQrCode/create');
    expect(created).toHaveLength(1);
    expect(created[0]!.req.headers!.authorization).toBe('Bearer abc_dev_CHAVEVALIDA123');
    expect(JSON.parse(created[0]!.req.body!).description.length).toBeLessThanOrEqual(37);

    expect((await anon.get(`/api/pay/${'0'.repeat(64)}`)).statusCode).toBe(404);
    expect((await anon.get('/api/pay/abc')).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('webhook só com segredo; a baixa vem da consulta à API, não do conteúdo do aviso', async () => {
    const o = await setupOnlineOrg();
    const anon = new (await import('./helpers.js')).Agent(ctx);
    const pix = json(await anon.get(`/api/pay/${o.token}`)).pix;
    const pixId = pix.brCode.split('-PIX-')[1];
    const { rows: org } = await ctx.owner.query('select webhook_id from organizations where id = $1', [o.orgId]);
    const hook = `/api/webhooks/abacatepay/${org[0].webhook_id}`;
    const body = { event: 'billing.paid', data: { pixQrCode: { id: pixId, status: 'PAID', amount: 15000 } } };

    expect((await anon.post(`${hook}?webhookSecret=errado`, body)).statusCode).toBe(403);
    expect((await anon.post(hook, body)).statusCode).toBe(403);
    // Aviso forjado (provedor ainda diz PENDING): nada muda.
    const forged = await anon.post(`${hook}?webhookSecret=${o.settings.webhookSecret}`, body);
    expect(forged.statusCode).toBe(200);
    expect((await ctx.owner.query('select status from charges where id = $1', [o.chargeId])).rows[0].status).toBe('aberta');

    abacate.pix.get(pixId)!.status = 'PAID';
    const real = json(await anon.post(`${hook}?webhookSecret=${o.settings.webhookSecret}`, body));
    expect(real).toMatchObject({ processed: 1, paid: 1 });
    const ch = (await ctx.owner.query('select status, paid_amount_cents, payment_method from charges where id = $1', [o.chargeId])).rows[0];
    expect(ch).toMatchObject({ status: 'paga', paid_amount_cents: 15000, payment_method: 'pix' });
    const conf = await ctx.owner.query(`select channel, status from messages where charge_id = $1 and kind = 'confirmacao'`, [o.chargeId]);
    expect(conf.rows).toHaveLength(1);
    expect((await ctx.owner.query(`select 1 from audit_events where entity_id = $1 and action = 'charge.paid_online'`, [o.chargeId])).rowCount).toBe(1);
    // Repetir o aviso não duplica nada.
    await anon.post(`${hook}?webhookSecret=${o.settings.webhookSecret}`, body);
    expect((await ctx.owner.query(`select 1 from messages where charge_id = $1 and kind = 'confirmacao'`, [o.chargeId])).rowCount).toBe(1);
    expect(json(await anon.get(`/api/pay/${o.token}`)).status).toBe('paga');
  });

  it('PIX de outra organização citado no webhook é ignorado', async () => {
    const a = await setupOnlineOrg();
    const b = await setupOnlineOrg('abc_prod_OUTRACHAVE456');
    const anon = new (await import('./helpers.js')).Agent(ctx);
    const pixB = json(await anon.get(`/api/pay/${b.token}`)).pix.brCode.split('-PIX-')[1];
    abacate.pix.get(pixB)!.status = 'PAID';
    const { rows } = await ctx.owner.query('select webhook_id from organizations where id = $1', [a.orgId]);
    const r = json(await anon.post(`/api/webhooks/abacatepay/${rows[0].webhook_id}?webhookSecret=${a.settings.webhookSecret}`, { data: { pixQrCode: { id: pixB } } }));
    expect(r.processed).toBe(0);
    expect((await ctx.owner.query('select status from charges where id = $1', [b.chargeId])).rows[0].status).toBe('aberta');
  });

  it('sem webhook: a rotina periódica confere e dá baixa; "Já paguei" e simulação em modo de teste', async () => {
    const o = await setupOnlineOrg();
    const anon = new (await import('./helpers.js')).Agent(ctx);
    const pixId = json(await anon.get(`/api/pay/${o.token}`)).pix.brCode.split('-PIX-')[1];
    expect(json(await anon.post(`/api/pay/${o.token}/check`)).status).toBe('aberta');
    abacate.pix.get(pixId)!.status = 'PAID';
    await ctx.owner.query('update online_payments set checked_at = null');
    await pollOnlinePayments(ctx.deps, 100);
    expect((await ctx.owner.query('select status from charges where id = $1', [o.chargeId])).rows[0].status).toBe('paga');

    const c2 = await createCharge(o.owner, o.customerId, undefined, 9900);
    const t2 = (await ctx.owner.query('select pay_token from charges where id = $1', [c2])).rows[0].pay_token;
    await anon.get(`/api/pay/${t2}`);
    expect(json(await anon.post(`/api/pay/${t2}/simulate`)).status).toBe('paga');
  });

  it('simulação recusada com chave de produção; organização sem PIX online não gera nada', async () => {
    const o = await setupOnlineOrg('abc_prod_OUTRACHAVE456');
    const anon = new (await import('./helpers.js')).Agent(ctx);
    await anon.get(`/api/pay/${o.token}`);
    expect((await anon.post(`/api/pay/${o.token}/simulate`)).statusCode).toBe(409);

    const plain = await createOrg(ctx, platform);
    const cid = await createCustomer(plain.owner);
    const ch = await createCharge(plain.owner, cid);
    const t = (await ctx.owner.query('select pay_token from charges where id = $1', [ch])).rows[0].pay_token;
    const before = abacateCalls('/pixQrCode/create').length;
    const page = json(await anon.get(`/api/pay/${t}`));
    expect(page.pix).toBeNull();
    expect(page.unavailable).toBeTruthy();
    expect(abacateCalls('/pixQrCode/create').length).toBe(before);
    // E o lembrete dessa organização não ganha link de pagamento do Venceu.
    const send = json(await plain.owner.post(`/api/charges/${ch}/send`, { channel: 'whatsapp' }));
    expect((await ctx.owner.query('select body from messages where id = $1', [send.messageId])).rows[0].body).not.toContain('/pagar/');
  });

  it('painel não altera o link nem liga o PIX online sem a chave', async () => {
    const o = await setupOnlineOrg();
    const client = await ctx.deps.pools.app.connect();
    try {
      await client.query('begin');
      const { rows } = await ctx.owner.query('select id from users where organization_id = $1 limit 1', [o.orgId]);
      await client.query(`select set_config('app.user_id', $1, true)`, [rows[0].id]);
      await expect(client.query(`update charges set pay_token = repeat('a', 64) where id = $1`, [o.chargeId])).rejects.toThrow();
      await client.query('rollback');
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [rows[0].id]);
      await expect(client.query(`update organizations set online_pay = false where id = $1`, [o.orgId])).rejects.toThrow();
      await client.query('rollback');
      await client.query('begin');
      await client.query(`select set_config('app.user_id', $1, true)`, [rows[0].id]);
      await expect(client.query(`select * from online_payments`)).rejects.toThrow();
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('coleta de ids do aviso tem limites', () => {
    const deep = { data: { a: { b: { c: { d: { e: { f: { g: { id: 'fundo' } } } } } } }, pixQrCode: { id: 'pix_char_1' } } };
    expect([...collectIds(deep)]).toEqual(['pix_char_1']);
    const many = { list: Array.from({ length: 50 }, (_, i) => ({ id: `x${i}` })) };
    expect(collectIds(many).size).toBe(20);
  });
});
