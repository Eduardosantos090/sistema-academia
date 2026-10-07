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
    // Cobrança avulsa com vencimento distante NÃO renova o acesso (só as do plano, e no máximo um período).
    const custId = (await ctx.owner.query('select billing_customer_id as id from organizations where id = $1', [tenant.orgId])).rows[0].id;
    const avulsa = (await billing.owner.post('/api/charges', { customerId: custId, description: 'Avulsa', amountCents: 100, dueDate: '2099-01-10' })).json().id;
    await billing.owner.post(`/api/charges/${avulsa}/pay`, { method: 'pix', notify: false });
    expect(json(await platform.get(`/api/platform/orgs/${tenant.orgId}`)).accessUntil).toBe(after.accessUntil);
  });

  it('desativar e reativar acesso manualmente', async () => {
    const c = await createOrg(ctx, platform);
    expect((await platform.patch(`/api/platform/orgs/${c.orgId}`, { isActive: false })).statusCode).toBe(200);
    expect(json(await platform.get(`/api/platform/orgs/${c.orgId}`)).suspendedReason).toBe('manual');
    expect((await platform.patch(`/api/platform/orgs/${c.orgId}`, { isActive: true })).statusCode).toBe(200);
    expect(json(await platform.get(`/api/platform/orgs/${c.orgId}`))).toMatchObject({ isActive: true, suspendedReason: null });
  });
});

describe('áudio gravado no navegador', () => {
  it('WebM/Opus é convertido para Ogg/Opus válido', async () => {
    const { readFileSync } = await import('node:fs');
    const { oggCrc } = await import('../src/lib/webm-to-ogg.js');
    const { owner } = await createOrg(ctx, platform);
    const webm = readFileSync(new URL('./fixtures/voz.webm', import.meta.url));
    const r = await owner.post('/api/media', { name: 'gravacao.webm', data: webm.toString('base64') });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ mime: 'audio/ogg', name: 'gravacao.ogg' });
    const file = (await ctx.app.inject({ method: 'GET', url: new URL(r.json().url).pathname })).rawPayload;
    // Percorre as páginas Ogg conferindo assinatura e CRC; a última traz a duração (~3 s a 48 kHz).
    let pos = 0;
    let pages = 0;
    let granule = 0n;
    while (pos < file.length) {
      expect(file.subarray(pos, pos + 4).toString('latin1')).toBe('OggS');
      const nseg = file[pos + 26]!;
      const body = file.subarray(pos + 27, pos + 27 + nseg).reduce((a, x) => a + x, 0);
      const page = Buffer.from(file.subarray(pos, pos + 27 + nseg + body));
      const crc = page.readUInt32LE(22);
      page.writeUInt32LE(0, 22);
      expect(oggCrc(page)).toBe(crc);
      granule = file.readBigInt64LE(pos + 6);
      pos += 27 + nseg + body;
      pages++;
    }
    expect(pages).toBeGreaterThan(2);
    expect(Number(granule) / 48000).toBeGreaterThan(2.9);
    expect(file.subarray(28, 36).toString('latin1')).toBe('OpusHead');
  });
});

describe('importação de clientes por planilha', () => {
  it('importa, cria assinaturas, ignora duplicados e informa erros por linha', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    await owner.post('/api/plans', { name: 'Plano Mensal', amountCents: 12990, intervalMonths: 1 });
    const due = await orgToday(ctx, orgId, 5);
    const rows = [
      { name: 'Ana Importada', phone: '(11) 95555-0001', email: 'ana@imp.test', planName: 'plano mensal', firstDueDate: due },
      { name: 'Beto Personalizado', phone: '11955550002', amountCents: 9900, intervalMonths: 3, planName: 'Trimestral promo', firstDueDate: due },
      { name: 'Carla Sem Plano', email: 'carla@imp.test' },
      { name: 'Ana Repetida', phone: '+5511955550001' },
      { name: 'X', phone: 'abc' },
      { name: 'Sem Valor', planName: 'Plano Inexistente', firstDueDate: due },
    ];
    const r = await owner.post('/api/customers/import', { rows });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ created: 3, subscriptions: 2, duplicates: 1 });
    expect(r.json().errors.map((e: { line: number }) => e.line)).toEqual([6, 7]);
    const list = json(await owner.get('/api/customers?pageSize=50'));
    expect(list.total).toBe(3);
    const ana = list.items.find((c: { name: string }) => c.name === 'Ana Importada');
    expect(ana).toMatchObject({ planName: 'Plano Mensal', nextDueDate: due });
    const beto = json(await owner.get(`/api/customers/${list.items.find((c: { name: string }) => c.name === 'Beto Personalizado').id}`));
    expect(beto.subscriptions[0]).toMatchObject({ amountCents: 9900, intervalMonths: 3, description: 'Trimestral promo' });
  });
});

describe('exportação em planilha', () => {
  it('exporta cobranças e clientes da própria organização, protegendo contra fórmulas', async () => {
    const a = await createOrg(ctx, platform);
    const b = await createOrg(ctx, platform);
    const c = await createCustomer(a.owner, { name: '=HYPERLINK("http://mal.example","clique")', phone: '(11) 95000-1111' });
    await a.owner.post('/api/charges', { customerId: c, description: 'Mensalidade; outubro', amountCents: 12990, dueDate: await orgToday(ctx, a.orgId, 3) });
    await createCustomer(b.owner, { name: 'Cliente da Outra Empresa', phone: '(11) 95000-2222' });
    const ch = await a.owner.get('/api/charges/export?filter=abertas');
    expect(ch.statusCode).toBe(200);
    expect(ch.headers['content-type']).toContain('text/csv');
    expect(ch.headers['content-disposition']).toContain('attachment');
    expect(ch.body.charCodeAt(0)).toBe(0xfeff);
    expect(ch.body).toContain(`"'=HYPERLINK(""http://mal.example"",""clique"")"`);
    expect(ch.body).toContain('"Mensalidade; outubro";129,90');
    const cu = await a.owner.get('/api/customers/export');
    expect(cu.body).not.toContain('Outra Empresa');
    expect(cu.body.split('\r\n').filter(Boolean)).toHaveLength(2);
    expect((await platform.get('/api/customers/export')).statusCode).toBe(403);
  });
});

describe('correções da auditoria de segurança', () => {
  it('bloqueia variações IPv6 de endereços internos (SSRF)', async () => {
    const { owner } = await createOrg(ctx, platform);
    for (const url of ['https://[::ffff:127.0.0.1]/x', 'https://[::ffff:a9fe:a9fe]/x', 'https://[::127.0.0.1]/x', 'https://[2002:7f00:1::]/x', 'https://[fd00::1]/x']) {
      expect((await owner.put('/api/settings/whatsapp', { mode: 'webhook', webhookUrl: url })).statusCode, url).toBe(422);
    }
  });

  it('caminho codificado (/%61pi/...) não escapa da verificação de sessão e CSRF', async () => {
    const { owner } = await createOrg(ctx, platform);
    const anon = await ctx.app.inject({ method: 'GET', url: '/%61pi/team' });
    expect(anon.statusCode).toBe(401);
    const noCsrf = await owner.request('POST', '/%61pi/customers', { name: 'Sem CSRF' }, { 'x-csrf-token': 'errado' });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('responsável não gera link de senha de outro responsável', async () => {
    const org = await createOrg(ctx, platform);
    const other = await inviteStaff(ctx, org.owner, 'owner');
    const staff = await inviteStaff(ctx, org.owner, 'staff');
    expect((await org.owner.post(`/api/team/${other.id}/reset-link`)).statusCode).toBe(403);
    // Para a equipe o pedido é aceito (aqui o e-mail está ativo, então a orientação é usar "Esqueci minha senha": 400).
    expect((await org.owner.post(`/api/team/${staff.id}/reset-link`)).statusCode).toBe(400);
  });

  it('webhook genérico exige id da mensagem (impede reenvio)', async () => {
    const { owner, orgId } = await createOrg(ctx, platform);
    const secret = (await owner.put('/api/settings/whatsapp', { mode: 'webhook', webhookUrl: 'https://hooks.exemplo.com/y' })).json().webhookSecret;
    const hook = (await ctx.owner.query('select webhook_id from organizations where id = $1', [orgId])).rows[0].webhook_id;
    const raw = JSON.stringify({ from: '5511900001111', text: 'oi' });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
    const r = await ctx.app.inject({ method: 'POST', url: `/api/webhooks/inbound/${hook}`, payload: raw, headers: { 'content-type': 'application/json', 'x-venceu-timestamp': ts, 'x-venceu-signature': sig } });
    expect(r.statusCode).toBe(422);
  });
});
