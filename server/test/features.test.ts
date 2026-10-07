import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchPending } from '../src/modules/automation/dispatch.js';
import { runMaintenance } from '../src/maintenance.js';
import { bootstrapPlatform, createCustomer, createOrg, inviteStaff, json, orgToday, setupApp, type Agent, type TestCtx } from './helpers.js';

let ctx: TestCtx;
let platform: Agent;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 2)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(80, ' '));

beforeAll(async () => {
  ctx = await setupApp();
  platform = (await bootstrapPlatform(ctx)).agent;
});
afterAll(() => ctx.close());

async function cloud(owner: Agent) {
  expect((await owner.put('/api/settings/whatsapp', { mode: 'cloud_api', phoneNumberId: '1234567890', accessToken: 'TK', appSecret: 'AS' })).statusCode).toBe(200);
}

describe('anexos (imagem, áudio, PDF)', () => {
  it('aceita só formatos permitidos (pelo conteúdo) e serve pelo link público', async () => {
    const { owner } = await createOrg(ctx, platform);
    const bad = await owner.post('/api/media', { name: 'foto.png', data: HTML.toString('base64') });
    expect(bad.statusCode).toBe(415);
    const ok = await owner.post('/api/media', { name: 'tabela de preços.png', data: PNG.toString('base64') });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ mime: 'image/png', sizeBytes: PNG.length });
    const url = new URL(ok.json().url);
    const pub = await ctx.app.inject({ method: 'GET', url: url.pathname });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('image/png');
    expect(pub.headers['content-security-policy']).toContain("default-src 'none'");
    expect(pub.rawPayload.equals(PNG)).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/media/${'0'.repeat(64)}/x.png` })).statusCode).toBe(404);
  });

  it('outra organização não usa o arquivo da primeira', async () => {
    const a = await createOrg(ctx, platform);
    const b = await createOrg(ctx, platform);
    const m = (await a.owner.post('/api/media', { name: 'a.png', data: PNG.toString('base64') })).json();
    const r = await b.owner.post('/api/bot-answers', { title: 'Preços', keywords: ['preco'], answer: 'Veja', mediaId: m.id });
    expect(r.statusCode).toBe(422);
    expect(json(await b.owner.get('/api/media')).items).toHaveLength(0);
  });

  it('assistente responde com anexo pela API oficial (texto como legenda)', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    await cloud(owner);
    const m = (await owner.post('/api/media', { name: 'precos.png', data: PNG.toString('base64') })).json();
    expect((await owner.post('/api/bot-answers', { title: 'Preços', keywords: ['preco', 'valores'], answer: 'Nossa tabela:', mediaId: m.id })).statusCode).toBe(201);
    const hook = (await ctx.owner.query('select webhook_id from organizations where id = $1', [orgId])).rows[0].webhook_id;
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '5511944443333', id: 'w1', type: 'text', text: { body: 'qual o preço?' } }] } }] }] });
    const sig = `sha256=${createHmac('sha256', 'AS').update(raw).digest('hex')}`;
    ctx.http.calls = [];
    const r = await ctx.app.inject({ method: 'POST', url: `/api/webhooks/whatsapp/${hook}`, payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
    expect(r.statusCode).toBe(200);
    const sent = JSON.parse(ctx.http.calls.at(-1)!.req.body!);
    expect(sent).toMatchObject({ type: 'image', image: { caption: 'Nossa tabela:' } });
    expect(sent.image.link).toContain(`/api/media/${m.token}/`);
    const sim = json(await owner.post('/api/bot/simulate', { text: 'valores' }));
    expect(sim.media.url).toContain(m.token);
  });

  it('atendente envia áudio na conversa (texto e áudio em mensagens separadas)', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    await cloud(owner);
    await ctx.owner.query(`insert into conversations (organization_id, phone) values ($1, '+5511933332222')`, [orgId]);
    const conv = json(await owner.get('/api/conversations')).items[0];
    const audio = (await owner.post('/api/media', { name: 'recado.ogg', data: OGG.toString('base64') })).json();
    expect(audio.mime).toBe('audio/ogg');
    ctx.http.calls = [];
    const r = await owner.post(`/api/conversations/${conv.id}/reply`, { text: 'Segue o áudio', mediaId: audio.id });
    expect(r.statusCode).toBe(200);
    const types = ctx.http.calls.map((c) => JSON.parse(c.req.body!).type);
    expect(types).toEqual(['text', 'audio']);
    const detail = json(await owner.get(`/api/conversations/${conv.id}`));
    expect(detail.messages.at(-1).mediaUrl).toContain(audio.token);
  });
});

describe('intervalo entre disparos', () => {
  it('com intervalo, envia uma por vez e o resto fica para a próxima janela', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    await cloud(owner);
    expect((await owner.patch('/api/settings/organization', { sendDelaySeconds: 120 })).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      const c = await createCustomer(owner, { name: `Cliente ${i}`, phone: `(11) 9700${i}-0000`, email: null });
      await owner.post('/api/charges', { customerId: c, description: 'Mensalidade', amountCents: 1000, dueDate: await orgToday(ctx, orgId, 2) });
    }
    const r = await owner.post('/api/reminders/send', { allMissing: true, days: 7, whatsapp: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().queued).toBe(3);
    const counts = async () =>
      (await ctx.owner.query(`select status, count(*)::int as n from messages where organization_id = $1 group by status`, [orgId])).rows;
    expect(await counts()).toEqual(expect.arrayContaining([{ status: 'enviada', n: 1 }, { status: 'pendente', n: 2 }]));
    await dispatchPending(ctx.deps, { deadline: Date.now() + 3000 });
    expect(await counts()).toEqual(expect.arrayContaining([{ status: 'enviada', n: 1 }]));
    // Passado o intervalo, sai a próxima.
    await ctx.owner.query(`update organizations set last_dispatch_at = now() - interval '3 minutes' where id = $1`, [orgId]);
    await dispatchPending(ctx.deps, { deadline: Date.now() + 3000 });
    expect(await counts()).toEqual(expect.arrayContaining([{ status: 'enviada', n: 2 }, { status: 'pendente', n: 1 }]));
  });
});

describe('controle de lembretes e painel', () => {
  it('mostra quem recebeu e quem falta; disparo não duplica', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    const staff = (await inviteStaff(ctx, owner)).agent;
    const a = await createCustomer(owner, { name: 'Ana Recebeu', phone: '(11) 96000-0001', email: null });
    const b = await createCustomer(owner, { name: 'Bia Falta', phone: '(11) 96000-0002', email: null });
    const ca = (await owner.post('/api/charges', { customerId: a, description: 'Mensalidade', amountCents: 1000, dueDate: await orgToday(ctx, orgId, 1) })).json().id;
    await owner.post('/api/charges', { customerId: b, description: 'Mensalidade', amountCents: 1000, dueDate: await orgToday(ctx, orgId, 2) });
    const send = (await staff.post(`/api/charges/${ca}/send`, { channel: 'whatsapp' })).json();
    await staff.post(`/api/messages/${send.messageId}/mark-sent`);
    const list = json(await staff.get('/api/reminders?days=3'));
    expect(list.counts).toMatchObject({ total: 2, enviado: 1, faltando: 1 });
    expect(list.items.find((i: { customerName: string }) => i.customerName === 'Bia Falta').reminderStatus).toBe('faltando');
    const bulk = json(await staff.post('/api/reminders/send', { allMissing: true, days: 3, whatsapp: true }));
    expect(bulk.manual).toBe(1);
    const again = await staff.post('/api/reminders/send', { allMissing: true, days: 3, whatsapp: true });
    expect(again.statusCode).toBe(409); // ninguém mais faltando (já está na fila manual)
    const dash = json(await owner.get('/api/dashboard'));
    expect(dash.dueSoon.map((d: { inDays: number }) => d.inDays).sort()).toEqual([1, 2]);
    expect(dash.dueSoon.find((d: { customerName: string }) => d.customerName === 'Ana Recebeu').reminded).toBe(true);
  });
});

describe('plano e acesso das organizações (plataforma)', () => {
  it('ativar plano manualmente libera o acesso; cliente não altera o próprio plano', async () => {
    const c = await createOrg(ctx, platform);
    const r = await platform.post(`/api/platform/orgs/${c.orgId}/extend`, { months: 1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().accessUntil).toBe(await orgToday(ctx, c.orgId, 0).then((d) => {
      const x = new Date(`${d}T00:00:00Z`);
      x.setUTCMonth(x.getUTCMonth() + 1);
      return x.toISOString().slice(0, 10);
    }));
    expect(json(await c.owner.get('/api/counters')).accessUntil).toBe(r.json().accessUntil);
    expect((await c.owner.put(`/api/platform/orgs/${c.orgId}/plan`, {})).statusCode).toBe(403);
  });

  it('suspensão automática por atraso e reativação automática ao registrar o pagamento', async () => {
    const billing = await createOrg(ctx, platform, 'Venceu Cobranças');
    expect((await platform.put('/api/platform/billing-org', { orgId: billing.orgId })).statusCode).toBe(200);
    const tenant = await createOrg(ctx, platform, 'Academia Cliente');
    const yesterday = await orgToday(ctx, tenant.orgId, -10);
    expect((await platform.put(`/api/platform/orgs/${tenant.orgId}/plan`, {
      planName: 'Pro', amountCents: 9900, intervalMonths: 1, accessUntil: yesterday, autoSuspend: true, graceDays: 3,
    })).statusCode).toBe(200);
    const ab = await platform.post(`/api/platform/orgs/${tenant.orgId}/auto-billing`, { enable: true, firstDueDate: yesterday });
    expect(ab.statusCode).toBe(200);
    // Rotina: vencido há 10 dias, tolerância 3 → suspende.
    await runMaintenance(ctx.deps, 2000);
    expect((await tenant.owner.get('/api/dashboard')).statusCode).toBe(401);
    const org = json(await platform.get(`/api/platform/orgs/${tenant.orgId}`));
    expect(org).toMatchObject({ isActive: false, suspendedReason: 'inadimplencia', autoBilling: true });
    // Na organização de cobrança aparece a cobrança do plano; ao pagar, o acesso volta.
    const charges = json(await billing.owner.get('/api/charges?filter=atrasadas'));
    expect(charges.items[0]).toMatchObject({ amountCents: 9900, customerName: 'Academia Cliente' });
    expect((await billing.owner.post(`/api/charges/${charges.items[0].id}/pay`, { method: 'pix', notify: false })).statusCode).toBe(200);
    const after = json(await platform.get(`/api/platform/orgs/${tenant.orgId}`));
    expect(after.isActive).toBe(true);
    expect(after.suspendedReason).toBeNull();
    expect(after.accessUntil > yesterday).toBe(true);
  });

  it('desativar e reativar acesso manualmente', async () => {
    const c = await createOrg(ctx, platform);
    expect((await platform.patch(`/api/platform/orgs/${c.orgId}`, { isActive: false })).statusCode).toBe(200);
    expect(json(await platform.get(`/api/platform/orgs/${c.orgId}`)).suspendedReason).toBe('manual');
    expect((await platform.patch(`/api/platform/orgs/${c.orgId}`, { isActive: true })).statusCode).toBe(200);
    expect(json(await platform.get(`/api/platform/orgs/${c.orgId}`))).toMatchObject({ isActive: true, suspendedReason: null });
  });
});
