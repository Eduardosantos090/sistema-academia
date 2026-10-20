import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchPending } from '../src/modules/automation/dispatch.js';
import { Agent, bootstrapPlatform, createCharge, createCustomer, createOrg, inviteStaff, json, orgToday, setupApp, type TestCtx } from './helpers.js';
import type { HttpRequest } from '../src/lib/http.js';

let ctx: TestCtx;
let platform: Agent;
const EVO = 'https://evo.example.com';
const GLOBAL = 'GLOBAL-KEY-123456';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

/** Evolution API simulada. */
class FakeEvo {
  instances = new Map<string, { token: string; state: string; webhook: { url: string; headers: Record<string, string>; events: string[] } }>();
  sent: { path: string; body: Record<string, unknown> }[] = [];
  handle(url: string, req: HttpRequest) {
    const u = new URL(url);
    const key = req.headers?.apikey;
    const ok = (d: unknown) => ({ status: 200, body: JSON.stringify(d) });
    if (u.pathname === '/instance/fetchInstances') return key === GLOBAL ? ok([]) : { status: 401, body: '{"message":"Unauthorized"}' };
    if (u.pathname === '/instance/create') {
      if (key !== GLOBAL) return { status: 401, body: '{}' };
      const b = JSON.parse(req.body!);
      const token = `TOKEN-${b.instanceName}`;
      this.instances.set(b.instanceName, { token, state: 'connecting', webhook: b.webhook });
      return ok({ instance: { instanceName: b.instanceName, status: 'connecting' }, hash: token, qrcode: { base64: PNG, code: '2@abc' } });
    }
    const [, group, action, name] = u.pathname.split('/');
    const inst = this.instances.get(decodeURIComponent(name ?? ''));
    if (req.method === 'DELETE' && action === 'delete') { if (key === GLOBAL) this.instances.delete(name!); return ok({ status: 'SUCCESS' }); }
    if (!inst) return { status: 404, body: '{"response":{"message":["not found"]}}' };
    if (key !== inst.token) return { status: 401, body: '{}' };
    if (group === 'instance' && action === 'connect') return inst.state === 'open' ? ok({ instance: { instanceName: name, state: 'open' } }) : ok({ base64: PNG, code: '2@x', count: 1 });
    if (group === 'instance' && action === 'connectionState') return ok({ instance: { instanceName: name, state: inst.state } });
    if (req.method === 'DELETE' && action === 'logout') { inst.state = 'close'; return ok({ status: 'SUCCESS' }); }
    if (group === 'message') {
      this.sent.push({ path: `${action}`, body: JSON.parse(req.body!) });
      return ok({ key: { id: `MSG${this.sent.length}`, remoteJid: 'x', fromMe: true } });
    }
    return { status: 404, body: '{}' };
  }
}

let evo: FakeEvo;
beforeAll(async () => {
  ctx = await setupApp();
  platform = (await bootstrapPlatform(ctx)).agent;
});
beforeEach(() => {
  evo = new FakeEvo();
  ctx.http.respond = (url, req) => (url.startsWith(EVO) ? evo.handle(url, req) : { status: 200, body: '{}' });
});
afterAll(() => ctx.close());

describe('tempo de resposta do assistente', () => {
  it('primeira resposta espera o tempo configurado; demais até 1,5 s; total até 8 s', async () => {
    const { replyTypingPlan } = await import('../src/modules/channels/service.js');
    expect(replyTypingPlan(3, 3)).toEqual([3000, 1500, 1500]);
    expect(replyTypingPlan(8, 3)).toEqual([8000, 0, 0]);
    expect(replyTypingPlan(0, 2)).toEqual([0, 0]);
  });
});

describe('WhatsApp por QR Code (Evolution API)', () => {
  it('plataforma configura o servidor; empresa conecta lendo o QR Code e passa a enviar e receber', async () => {
    expect((await platform.put('/api/platform/whatsapp-server', { url: EVO, apiKey: 'errada-123456' })).statusCode).toBe(422);
    expect((await platform.put('/api/platform/whatsapp-server', { url: 'http://evo.example.com', apiKey: GLOBAL })).statusCode).toBe(422);
    expect((await platform.put('/api/platform/whatsapp-server', { url: EVO, apiKey: GLOBAL })).statusCode).toBe(200);
    expect(JSON.stringify(json(await platform.get('/api/platform/whatsapp-server')))).not.toContain(GLOBAL);

    const { owner, orgId } = await createOrg(ctx, platform);
    const staff = (await inviteStaff(ctx, owner)).agent;
    expect((await staff.post('/api/settings/whatsapp/qrcode/connect')).statusCode).toBe(403);
    expect(json(await owner.get('/api/settings')).channels.qrcode).toMatchObject({ available: true, connected: false });

    const c1 = json(await owner.post('/api/settings/whatsapp/qrcode/connect'));
    expect(c1).toMatchObject({ state: 'connecting', qr: PNG });
    const [name, inst] = [...evo.instances.entries()][0]!;
    const { rows: o } = await ctx.owner.query('select webhook_id from organizations where id = $1', [orgId]);
    expect(inst.webhook.url).toMatch(new RegExp(`/api/webhooks/evolution/${o[0].webhook_id}$`));
    expect(inst.webhook.events).toEqual(['MESSAGES_UPSERT', 'CONNECTION_UPDATE']);
    const secret = inst.webhook.headers['x-venceu-token']!;
    const enc = await ctx.owner.query('select evo_token_enc from org_channels where organization_id = $1', [orgId]);
    expect(enc.rows[0].evo_token_enc).not.toContain(inst.token);

    // Celular leu o QR Code.
    inst.state = 'open';
    expect(json(await owner.get('/api/settings/whatsapp/qrcode/status'))).toMatchObject({ state: 'open', active: true });
    const s = json(await owner.get('/api/settings'));
    expect(s.channels).toMatchObject({ whatsappMode: 'qrcode', whatsappAutomatic: true });

    // Lembrete sai pelo número da empresa.
    const cid = await createCustomer(owner, { name: 'Paulo QR', phone: '(11) 96666-5555', email: null });
    const ch = await createCharge(owner, cid, await orgToday(ctx, orgId, 1), 9900);
    const sent = json(await owner.post(`/api/charges/${ch}/send`, { channel: 'whatsapp' }));
    expect(['enviada', 'pendente']).toContain(sent.status);
    await dispatchPending(ctx.deps, { deadline: Date.now() + 3000 });
    const txt = evo.sent.find((m) => m.path === 'sendText')!;
    expect(txt.body.number).toBe('5511966665555');
    expect(String(txt.body.text)).toContain('Paulo');

    // Mensagem recebida vai para o assistente, que responde pelo mesmo número.
    const anon = new Agent(ctx);
    const hook = `/api/webhooks/evolution/${o[0].webhook_id}`;
    const msg = { event: 'messages.upsert', instance: name, data: { key: { remoteJid: '5511966665555@s.whatsapp.net', fromMe: false, id: 'WAMID1' }, message: { conversation: '1' } } };
    expect((await anon.post(hook, msg)).statusCode).toBe(403);
    expect((await anon.request('POST', hook, msg, { 'x-venceu-token': 'errado' })).statusCode).toBe(403);
    // Tempo de resposta do assistente: 3 s de "digitando…" (só nas respostas, não nos lembretes).
    expect(txt.body.delay).toBeUndefined();
    expect((await owner.patch('/api/settings/organization', { botReplyDelaySeconds: 3 })).statusCode).toBe(200);
    expect(json(await owner.get('/api/settings')).organization.botReplyDelaySeconds).toBe(3);
    const before = evo.sent.length;
    expect((await anon.request('POST', hook, msg, { 'x-venceu-token': secret })).statusCode).toBe(200);
    expect(evo.sent.length).toBeGreaterThan(before);
    expect(String(evo.sent.at(-1)!.body.text)).toMatch(/vencimento|aberto|R\$/i);
    expect(evo.sent[before]!.body.delay).toBe(3000);
    // Mensagens de grupo e as enviadas pelo próprio número são ignoradas.
    const n = evo.sent.length;
    await anon.request('POST', hook, { ...msg, data: { ...msg.data, key: { remoteJid: '123-456@g.us', fromMe: false, id: 'G1' } } }, { 'x-venceu-token': secret });
    await anon.request('POST', hook, { ...msg, data: { ...msg.data, key: { ...msg.data.key, fromMe: true, id: 'ME1' } } }, { 'x-venceu-token': secret });
    expect(evo.sent.length).toBe(n);

    // Celular desconectou: volta ao envio manual (link clique-para-enviar).
    await anon.request('POST', hook, { event: 'connection.update', instance: name, data: { state: 'close' } }, { 'x-venceu-token': secret });
    expect(json(await owner.get('/api/settings')).channels.whatsappAutomatic).toBe(false);

    // Desconectar remove a instância.
    expect((await owner.post('/api/settings/whatsapp/qrcode/disconnect')).statusCode).toBe(200);
    expect(evo.instances.size).toBe(0);
    expect(json(await owner.get('/api/settings')).channels).toMatchObject({ whatsappMode: 'manual', qrcode: { connected: false } });
  });

  it('sem servidor configurado, a empresa não vê a opção', async () => {
    await platform.put('/api/platform/whatsapp-server', { url: null });
    const { owner } = await createOrg(ctx, platform);
    expect(json(await owner.get('/api/settings')).channels.qrcode.available).toBe(false);
    expect((await owner.post('/api/settings/whatsapp/qrcode/connect')).statusCode).toBe(409);
  });
});
