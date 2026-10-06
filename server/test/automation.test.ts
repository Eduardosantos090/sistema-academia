import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { queueReminders } from '../src/modules/automation/reminders.js';
import { dispatchPending } from '../src/modules/automation/dispatch.js';
import { runMaintenance } from '../src/maintenance.js';
import { bootstrapPlatform, createCustomer, createOrg, json, openSendWindow, orgToday, setupApp, type Agent, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let platform: Agent;

beforeAll(async () => {
  ctx = await setupApp();
  platform = (await bootstrapPlatform(ctx)).agent;
});
afterAll(() => ctx.close());
beforeEach(() => {
  ctx.http.calls = [];
});

async function configureCloud(owner: Agent) {
  const r = await owner.put('/api/settings/whatsapp', { mode: 'cloud_api', phoneNumberId: '1234567890', accessToken: 'TOKEN-SECRETO-META', appSecret: 'APP-SECRET-META' });
  expect(r.statusCode).toBe(200);
}

describe('assinaturas geram cobranças', () => {
  it('cria cobranças dos próximos 30 dias e avança o próximo vencimento, sem duplicar', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    const first = await orgToday(ctx, orgId, 5);
    const r = await owner.post('/api/customers', {
      name: 'Aluno Recorrente', phone: '(47) 98840-0000',
      subscription: { description: 'Mensalidade', amountCents: 9990, intervalMonths: 1, firstDueDate: first },
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    const c = json(await owner.get(`/api/customers/${id}`));
    expect(c.charges).toHaveLength(1);
    expect(c.charges[0]).toMatchObject({ dueDate: first, amountCents: 9990, status: 'aberta' });
    expect(c.subscriptions[0].nextDueDate > first).toBe(true);
    await ctx.owner.query('select app.generate_charges(null, 30)');
    await ctx.owner.query('select app.generate_charges(null, 30)');
    expect(json(await owner.get(`/api/customers/${id}`)).charges).toHaveLength(1);
  });

  it('dia 31 vira o último dia em meses menores', async () => {
    const { rows } = await ctx.owner.query(`select app.add_months_keep_day('2027-01-31', 1, 31)::text as d`);
    expect(rows[0].d).toBe('2027-02-28');
  });

  it('cancelar a assinatura cancela as cobranças futuras em aberto', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    const cid = await createCustomer(owner);
    const s = await owner.post('/api/subscriptions', { customerId: cid, description: 'Plano', amountCents: 5000, intervalMonths: 1, firstDueDate: await orgToday(ctx, orgId, 10) });
    expect(s.statusCode).toBe(201);
    expect((await owner.patch(`/api/subscriptions/${s.json().id}`, { status: 'cancelada' })).statusCode).toBe(200);
    const c = json(await owner.get(`/api/customers/${cid}`));
    expect(c.charges[0].status).toBe('cancelada');
  });
});

describe('lembretes automáticos', () => {
  it('enfileira por regra e canal, respeitando consentimento, sem duplicar', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    await openSendWindow(ctx, orgId);
    const due = await orgToday(ctx, orgId, 3); // regra padrão D-3
    const yes = await createCustomer(owner, { name: 'Maria Teste', phone: '(11) 91234-5678', email: 'maria@example.test' });
    const noWa = await createCustomer(owner, { name: 'Sem WhatsApp', phone: '(11) 91234-0000', email: 'semwa@example.test', whatsappOptIn: false });
    for (const c of [yes, noWa]) {
      expect((await owner.post('/api/charges', { customerId: c, description: 'Mensalidade', amountCents: 12990, dueDate: due })).statusCode).toBe(201);
    }
    const n1 = await queueReminders(ctx.deps, orgId);
    const n2 = await queueReminders(ctx.deps, orgId);
    expect(n1).toBe(3); // Maria: WhatsApp + e-mail; Sem WhatsApp: só e-mail
    expect(n2).toBe(0);
    const { rows } = await ctx.owner.query(`select channel, status, body, to_address from messages where organization_id = $1 order by channel`, [orgId]);
    const wa = rows.filter((r) => r.channel === 'whatsapp');
    expect(wa).toHaveLength(1);
    expect(wa[0].status).toBe('manual'); // sem integração: envio manual pelo painel
    expect(wa[0].body).toContain('Olá, Maria!');
    expect(wa[0].body).toMatch(/R\$\s129,90/);
  });

  it('envia pela API oficial com token cifrado e marca como enviada; e-mail tem descadastro', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    await configureCloud(owner);
    await openSendWindow(ctx, orgId);
    const cid = await createCustomer(owner, { name: 'João Envio', phone: '(11) 97777-6666', email: 'joao@example.test' });
    await owner.post('/api/charges', { customerId: cid, description: 'Mensalidade', amountCents: 5000, dueDate: await orgToday(ctx, orgId, 3) });
    const { rows: enc } = await ctx.owner.query('select wa_access_token_enc from org_channels where organization_id = $1', [orgId]);
    expect(enc[0].wa_access_token_enc).not.toContain('TOKEN-SECRETO');
    await queueReminders(ctx.deps, orgId);
    const res = await dispatchPending(ctx.deps, { deadline: Date.now() + 10_000 });
    expect(res.sent).toBeGreaterThanOrEqual(2);
    const call = ctx.http.calls.find((c) => c.url.includes('/1234567890/messages'))!;
    expect(call.req.headers!.authorization).toBe('Bearer TOKEN-SECRETO-META');
    expect(JSON.parse(call.req.body!).to).toBe('5511977776666');
    const mail = ctx.mailer.outbox.find((m) => m.to === 'joao@example.test')!;
    expect(mail.text).toMatch(/\/descadastrar#t=/);
    const { rows } = await ctx.owner.query(`select status from messages where customer_id = $1`, [cid]);
    expect(rows.every((r) => r.status === 'enviada')).toBe(true);
  });

  it('falha do provedor fica registrada sem vazar o token e com nova tentativa', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    await configureCloud(owner);
    const cid = await createCustomer(owner, { email: null });
    const ch = await owner.post('/api/charges', { customerId: cid, description: 'Mensalidade', amountCents: 5000, dueDate: await orgToday(ctx, orgId, 1) });
    ctx.http.respond = () => ({ status: 401, body: JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }) });
    const r = await owner.post(`/api/charges/${ch.json().id}/send`, { channel: 'whatsapp' });
    ctx.http.respond = () => ({ status: 200, body: '{"messages":[{"id":"x"}]}' });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('pendente');
    expect(r.json().error).toContain('HTTP 401');
    expect(r.body).not.toContain('TOKEN-SECRETO');
  });

  it('pagamento cancela lembretes pendentes e envia confirmação', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    await openSendWindow(ctx, orgId);
    const cid = await createCustomer(owner, { name: 'Ana Paga', email: null });
    const ch = (await owner.post('/api/charges', { customerId: cid, description: 'Mensalidade', amountCents: 7000, dueDate: await orgToday(ctx, orgId, 3) })).json().id;
    await queueReminders(ctx.deps, orgId);
    const pay = await owner.post(`/api/charges/${ch}/pay`, { method: 'pix' });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().confirmation.waLink).toMatch(/^https:\/\/wa\.me\/5511988887777\?text=Pagamento%20confirmado/);
    const { rows } = await ctx.owner.query(`select kind, status from messages where charge_id = $1 order by created_at`, [ch]);
    expect(rows).toEqual([{ kind: 'lembrete', status: 'cancelada' }, { kind: 'confirmacao', status: 'manual' }]);
    expect((await owner.post(`/api/charges/${ch}/pay`, {})).statusCode).toBe(409);
  });

  it('rotina periódica completa roda sem erros', async () => {
    const r = await runMaintenance(ctx.deps, 5_000);
    expect(r).toHaveProperty('queued');
  });
});

describe('integrações: segurança', () => {
  it('URL de webhook interna/privada é recusada (SSRF)', async () => {
    const { owner } = await createOrg(ctx, platform);
    for (const url of ['http://exemplo.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://10.0.0.5/x', 'https://localhost/x', 'https://user:pw@exemplo.com/']) {
      const r = await owner.put('/api/settings/whatsapp', { mode: 'webhook', webhookUrl: url });
      expect(r.statusCode, url).toBe(422);
    }
    const ok = await owner.put('/api/settings/whatsapp', { mode: 'webhook', webhookUrl: 'https://hooks.exemplo.com/venceu' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().webhookSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const s = json(await owner.get('/api/settings'));
    expect(JSON.stringify(s)).not.toContain(ok.json().webhookSecret);
  });

  it('segredos nunca voltam ao navegador', async () => {
    const { owner } = await createOrg(ctx, platform);
    await configureCloud(owner);
    const body = (await owner.get('/api/settings')).body;
    expect(body).not.toContain('TOKEN-SECRETO-META');
    expect(body).not.toContain('APP-SECRET-META');
    expect(JSON.parse(body).channels).toMatchObject({ hasAccessToken: true, hasAppSecret: true, whatsappAutomatic: true });
  });

  it('modelos com variável desconhecida são recusados', async () => {
    const { owner } = await createOrg(ctx, platform);
    const r = await owner.post('/api/templates', { kind: 'lembrete', name: 'X', body: 'Olá {{senha_do_banco}}' });
    expect(r.statusCode).toBe(422);
  });
});
