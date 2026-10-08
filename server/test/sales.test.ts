import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { pollSignups } from '../src/modules/sales/service.js';
import { runMaintenance } from '../src/maintenance.js';
import { Agent, bootstrapPlatform, json, setupApp, type TestCtx } from './helpers.js';
import type { HttpRequest } from '../src/lib/http.js';

let ctx: TestCtx;
let platform: Agent;
let seq = Date.now();
const KEY = 'abc_dev_VENDAVENCEU123';
const PRODUCT = 'prod_XkFSP4HpB41XDPPXyMtKj5am';

/** AbacatePay v2 simulada para assinaturas. */
class FakeAbacate {
  subs = new Map<string, { id: string; checkoutId: string; externalId: string; status: string; amount: number }>();
  checkouts = new Map<string, { externalId: string; customerId: string; methods: string[] }>();
  productCycle: string | null = 'MONTHLY';
  handle(url: string, req: HttpRequest) {
    if (req.headers?.authorization !== `Bearer ${KEY}`) return { status: 401, body: '{"error":"Unauthorized"}' };
    const u = new URL(url);
    const ok = (data: unknown) => ({ status: 200, body: JSON.stringify({ data, error: null, success: true }) });
    switch (u.pathname) {
      case '/v2/stores/get': return ok({ id: 'store_1', name: 'Venceu', balance: {} });
      case '/v2/products/get':
        return u.searchParams.get('id') === PRODUCT
          ? ok({ id: PRODUCT, name: 'Venceu Mensal', price: 5000, cycle: this.productCycle, status: 'ACTIVE', devMode: true })
          : { status: 404, body: '{"error":"Product not found"}' };
      case '/v2/customers/create': return ok({ id: `cust_${++seq}`, email: JSON.parse(req.body!).email });
      case '/v2/subscriptions/create': {
        const b = JSON.parse(req.body!);
        if (b.items?.[0]?.id !== PRODUCT || b.items.length !== 1) return { status: 400, body: '{"error":"items"}' };
        const id = `bill_${++seq}`;
        this.checkouts.set(id, { externalId: b.externalId, customerId: b.customerId, methods: b.methods });
        return ok({ id, url: `https://app.abacatepay.com/pay/${id}`, amount: 5000, status: 'PENDING', devMode: true });
      }
      case '/v2/subscriptions/get': {
        const byId = u.searchParams.get('id');
        const byExt = u.searchParams.get('externalId');
        const s = [...this.subs.values()].find((x) => (byId && x.id === byId) || (byExt && x.externalId === byExt));
        return s ? ok({ id: s.id, checkoutId: s.checkoutId, customerId: 'c', amount: s.amount, status: s.status, method: 'CARD', coupons: [], devMode: true, trialDays: null, trialEndsAt: null, retryPolicy: {}, createdAt: '', updatedAt: '' })
          : { status: 404, body: '{"error":"Subscription not found"}' };
      }
    }
    return { status: 404, body: '{"error":"not found"}' };
  }
  /** O cliente paga o checkout: a assinatura passa a existir e fica ativa. */
  pay(checkoutId: string) {
    const c = this.checkouts.get(checkoutId)!;
    const id = `subs_${++seq}`;
    this.subs.set(id, { id, checkoutId, externalId: c.externalId, status: 'ACTIVE', amount: 5000 });
    return id;
  }
}

let abacate: FakeAbacate;
beforeAll(async () => {
  ctx = await setupApp();
  platform = (await bootstrapPlatform(ctx)).agent;
});
beforeEach(() => {
  abacate = new FakeAbacate();
  ctx.http.respond = (url, req) => (url.startsWith('https://api.abacatepay.com/') ? abacate.handle(url, req) : { status: 200, body: '{}' });
});
afterAll(() => ctx.close());

async function configure() {
  const r = await platform.put('/api/platform/sales', { enabled: true, apiKey: KEY, productId: PRODUCT, planName: 'Venceu Mensal', methods: ['CARD', 'PIX'] });
  expect(r.statusCode).toBe(200);
  return json(await platform.get('/api/platform/sales'));
}

const form = (email: string) => ({
  ownerName: 'Carlos Dono', businessName: 'Academia Vende Bem', segment: 'academia', email, phone: '(11) 97777-1234',
  password: 'SenhaForte#2026', consent: true,
});

describe('venda da assinatura do Venceu', () => {
  it('somente a plataforma configura; valida produto com ciclo; plano público reflete o preço do produto', async () => {
    const anon = new Agent(ctx);
    expect((await anon.get('/api/platform/sales')).statusCode).toBe(401);
    abacate.productCycle = null;
    expect((await platform.put('/api/platform/sales', { enabled: true, apiKey: KEY, productId: PRODUCT, planName: 'X Mensal', methods: ['CARD'] })).statusCode).toBe(422);
    abacate.productCycle = 'MONTHLY';
    expect((await platform.put('/api/platform/sales', { enabled: true, apiKey: 'abc_dev_ERRADA000000', productId: PRODUCT, planName: 'X Mensal', methods: ['CARD'] })).statusCode).toBe(422);
    const s = await configure();
    expect(s).toMatchObject({ enabled: true, available: true, productId: PRODUCT, priceCents: 5000, intervalMonths: 1, methods: ['CARD', 'PIX'] });
    expect(JSON.stringify(s)).not.toContain('VENDAVENCEU');
    expect(json(await anon.get('/api/public/plan'))).toMatchObject({ available: true, priceCents: 5000, planName: 'Venceu Mensal' });
  });

  it('cadastro → checkout → webhook → conta criada; a pessoa entra com a senha que escolheu', async () => {
    const s = await configure();
    const anon = new Agent(ctx);
    const email = `venda-${++seq}@example.test`;
    const r = json(await anon.post('/api/public/signup', form(email)));
    expect(r.url).toMatch(/^https:\/\/app\.abacatepay\.com\/pay\/bill_/);
    const checkoutId = r.url.split('/').pop();
    expect(abacate.checkouts.get(checkoutId)!.methods).toEqual(['CARD', 'PIX']);
    expect(json(await anon.get(`/api/public/signup/${r.token}`)).status).toBe('pendente');
    // Ainda não pagou: não entra.
    expect((await new Agent(ctx).post('/api/auth/login', { email, password: 'SenhaForte#2026' })).statusCode).toBeGreaterThanOrEqual(400);

    const subId = abacate.pay(checkoutId);
    const event = { id: `log_${++seq}`, event: 'subscription.completed', apiVersion: 2, data: { subscription: { id: subId, status: 'ACTIVE' } } };
    const hook = `/api/webhooks/abacatepay-venceu?webhookSecret=${s.webhookSecret}`;
    expect((await anon.post('/api/webhooks/abacatepay-venceu?webhookSecret=errado', event)).statusCode).toBe(403);
    const raw = JSON.stringify(event);
    const sig = createHmac('sha256', 't9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9').update(raw).digest('base64');
    expect((await anon.request('POST', hook, event, { 'x-webhook-signature': 'errada' })).statusCode).toBe(403);
    expect((await anon.request('POST', hook, event, { 'x-webhook-signature': sig })).statusCode).toBe(200);
    expect(json(await anon.get(`/api/public/signup/${r.token}`)).status).toBe('ativo');

    const { rows } = await ctx.owner.query(
      `select o.id, o.name, o.plan_name, o.plan_amount_cents, o.access_until - (now() at time zone 'America/Sao_Paulo')::date as days, o.auto_suspend,
              o.subscription_status, o.abacate_subscription_id, (select password_hash from signups where email = $1) as leftover
         from organizations o join users u on u.organization_id = o.id where u.email = $1`,
      [email],
    );
    expect(rows[0]).toMatchObject({ name: 'Academia Vende Bem', plan_name: 'Venceu Mensal', plan_amount_cents: 5000, auto_suspend: true, subscription_status: 'ativa', abacate_subscription_id: subId, leftover: null });
    expect(rows[0].days).toBeGreaterThanOrEqual(28);
    const owner = new Agent(ctx);
    await owner.login(email, 'SenhaForte#2026');
    expect(json(await owner.get('/api/auth/me')).user ?? json(await owner.get('/api/auth/me'))).toBeTruthy();
    expect((await owner.get('/api/dashboard')).statusCode).toBe(200);

    // Mesmo evento de novo: não cria nada em dobro.
    expect(json(await anon.request('POST', hook, event, { 'x-webhook-signature': sig })).duplicate).toBe(true);
    expect((await ctx.owner.query('select 1 from users where email = $1', [email])).rowCount).toBe(1);

    // Renovação estende o acesso (com limite); cancelamento marca a assinatura.
    const orgId = rows[0].id;
    await ctx.owner.query(`update organizations set access_until = (now() at time zone 'America/Sao_Paulo')::date + 1 where id = $1`, [orgId]);
    await anon.post(hook, { id: `log_${++seq}`, event: 'subscription.renewed', data: { subscription: { id: subId } } });
    await anon.post(hook, { id: `log_${++seq}`, event: 'subscription.renewed', data: { subscription: { id: subId } } });
    const after = (await ctx.owner.query(`select access_until - (now() at time zone 'America/Sao_Paulo')::date as days from organizations where id = $1`, [orgId])).rows[0].days;
    expect(after).toBeGreaterThanOrEqual(29);
    expect(after).toBeLessThanOrEqual(39); // dois avisos não somam dois meses
    abacate.subs.get(subId)!.status = 'CANCELLED';
    await anon.post(hook, { id: `log_${++seq}`, event: 'subscription.cancelled', data: { subscription: { id: subId } } });
    expect((await ctx.owner.query('select subscription_status, is_active from organizations where id = $1', [orgId])).rows[0]).toMatchObject({ subscription_status: 'cancelada', is_active: true });
  });

  it('aviso forjado (assinatura não ativa no provedor) não cria conta; sem webhook a rotina ativa', async () => {
    await configure();
    const anon = new Agent(ctx);
    const email = `venda-${++seq}@example.test`;
    const r = json(await anon.post('/api/public/signup', form(email)));
    const checkoutId = r.url.split('/').pop();
    const s = json(await platform.get('/api/platform/sales'));
    const hook = `/api/webhooks/abacatepay-venceu?webhookSecret=${s.webhookSecret}`;
    await anon.post(hook, { id: `log_${++seq}`, event: 'subscription.completed', data: { subscription: { id: 'subs_FALSO123' } } });
    expect(json(await anon.get(`/api/public/signup/${r.token}`)).status).toBe('pendente');

    abacate.pay(checkoutId);
    await ctx.owner.query(`update signups set checked_at = null where token = $1`, [r.token]);
    await pollSignups(ctx.deps, 50);
    expect(json(await anon.get(`/api/public/signup/${r.token}`)).status).toBe('ativo');
  });

  it('"Já paguei" confere na hora; e-mail já cadastrado é recusado; venda desligada não abre checkout', async () => {
    await configure();
    const anon = new Agent(ctx);
    const email = `venda-${++seq}@example.test`;
    const r = json(await anon.post('/api/public/signup', form(email)));
    expect(json(await anon.post(`/api/public/signup/${r.token}/check`)).status).toBe('pendente');
    abacate.pay(r.url.split('/').pop());
    expect(json(await anon.post(`/api/public/signup/${r.token}/check`)).status).toBe('ativo');
    expect((await new Agent(ctx).post('/api/public/signup', form(email))).statusCode).toBe(409);

    expect((await platform.put('/api/platform/sales', { enabled: false, productId: PRODUCT, planName: 'Venceu Mensal', methods: ['CARD'] })).statusCode).toBe(200);
    expect(json(await anon.get('/api/public/plan')).available).toBe(false);
    expect((await new Agent(ctx).post('/api/public/signup', form(`venda-${++seq}@example.test`))).statusCode).toBe(409);
    await configure();
  });

  it('acesso vence sem renovação: a rotina suspende a conta vendida', async () => {
    await configure();
    const anon = new Agent(ctx);
    const email = `venda-${++seq}@example.test`;
    const r = json(await anon.post('/api/public/signup', form(email)));
    abacate.pay(r.url.split('/').pop());
    await anon.post(`/api/public/signup/${r.token}/check`);
    const { rows } = await ctx.owner.query('select organization_id from signups where token = $1', [r.token]);
    await ctx.owner.query(`update organizations set access_until = current_date - 10 where id = $1`, [rows[0].organization_id]);
    await runMaintenance(ctx.deps, 3000);
    expect((await ctx.owner.query('select is_active, suspended_reason from organizations where id = $1', [rows[0].organization_id])).rows[0])
      .toMatchObject({ is_active: false, suspended_reason: 'inadimplencia' });
  });
});
