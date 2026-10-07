import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg } from '../../lib/context.js';
import { AppError } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { likePattern, zUuid } from '../../lib/normalize.js';
import { sendChargeMessage } from '../messages/service.js';
import { dispatchPending } from '../automation/dispatch.js';
import { loadChannels } from '../channels/service.js';

/**
 * Controle de lembretes: para cada cobrança em aberto (atrasadas e que vencem
 * nos próximos dias), mostra se o cliente JÁ recebeu lembrete, se falta, se
 * está na fila ou se o envio falhou. Permite disparar para quem falta.
 */
const STATUS_SQL = `case
  when s.sent > 0 then 'enviado'
  when s.queued > 0 then 'na_fila'
  when s.failed > 0 then 'falhou'
  else 'faltando' end`;

const BASE = (today: string) => `
  with s as (
    select ch.id,
           count(m.*) filter (where m.status = 'enviada')::int as sent,
           count(m.*) filter (where m.status in ('pendente', 'manual'))::int as queued,
           count(m.*) filter (where m.status = 'falhou')::int as failed,
           max(m.sent_at) as last_sent_at,
           (array_agg(m.channel::text order by m.sent_at desc nulls last) filter (where m.status = 'enviada'))[1] as last_channel,
           string_agg(distinct m.channel::text, ',') filter (where m.status = 'enviada') as channels
      from charges ch
      left join messages m on m.charge_id = ch.id and m.kind in ('lembrete', 'manual')
     where ch.status = 'aberta'
       and ch.due_date between ${today} - 90 and ${today} + $1::int
     group by ch.id
  )`;

const zFilters = z.object({
  days: z.coerce.number().int().refine((v) => [1, 2, 3, 7, 15, 30].includes(v)).default(7),
  status: z.enum(['todos', 'enviado', 'faltando', 'na_fila', 'falhou']).default('todos'),
  q: z.string().max(100).optional(),
});

export function registerReminderRoutes(app: FastifyInstance, deps: Deps) {
  const today = 'app.org_today(ch.organization_id)';

  app.get('/api/reminders', async (req) => {
    requireOrg(req);
    const f = parse(zFilters, req.query);
    return asUser(deps, req, async (db) => {
      const params: unknown[] = [f.days];
      const where: string[] = [];
      if (f.status !== 'todos') {
        params.push(f.status);
        where.push(`${STATUS_SQL} = $${params.length}`);
      }
      if (f.q) {
        params.push(likePattern(f.q));
        where.push(`cu.name ilike $${params.length}`);
      }
      const { rows } = await db.query(
        `${BASE(today)}
         select ch.id, ch.description, ch.amount_cents as "amountCents", to_char(ch.due_date, 'YYYY-MM-DD') as "dueDate",
                (${today} - ch.due_date) as "daysLate", ch.reported_paid_at as "reportedPaidAt",
                cu.id as "customerId", cu.name as "customerName", cu.phone as "customerPhone", cu.email as "customerEmail",
                cu.whatsapp_opt_in as "whatsappOptIn", cu.email_opt_in as "emailOptIn",
                s.sent, s.queued, s.failed, s.last_sent_at as "lastSentAt", s.last_channel as "lastChannel", s.channels,
                ${STATUS_SQL} as "reminderStatus"
           from s join charges ch on ch.id = s.id join customers cu on cu.id = ch.customer_id
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by ch.due_date, cu.name
          limit 500`,
        params,
      );
      const counts = await db.query(
        `${BASE(today)}
         select count(*)::int as total,
                count(*) filter (where ${STATUS_SQL} = 'enviado')::int as enviado,
                count(*) filter (where ${STATUS_SQL} = 'faltando')::int as faltando,
                count(*) filter (where ${STATUS_SQL} = 'na_fila')::int as na_fila,
                count(*) filter (where ${STATUS_SQL} = 'falhou')::int as falhou
           from s`,
        [f.days],
      );
      return { items: rows, counts: counts.rows[0] };
    });
  });

  /**
   * Disparo em massa: coloca na fila os lembretes das cobranças escolhidas (ou
   * de todas que ainda não receberam). O envio respeita o intervalo entre
   * disparos configurado; o que não sair agora sai nos próximos minutos.
   */
  app.post('/api/reminders/send', async (req) => {
    const me = requireOrg(req);
    const body = parse(
      z
        .object({
          chargeIds: z.array(zUuid).max(300).optional(),
          allMissing: z.boolean().default(false),
          days: zFilters.shape.days,
          whatsapp: z.boolean().default(true),
          email: z.boolean().default(false),
        })
        .strict()
        .refine((b) => b.whatsapp || b.email, { message: 'Escolha ao menos um canal.', path: ['whatsapp'] })
        .refine((b) => b.allMissing || b.chargeIds?.length, { message: 'Selecione as cobranças.', path: ['chargeIds'] }),
      req.body,
    );
    await deps.limiters.sendNow.consume(`bulk:${me.id}`);
    let ids = body.chargeIds ?? [];
    if (body.allMissing) {
      ids = await asUser(deps, req, async (db) => {
        const { rows } = await db.query<{ id: string }>(
          `${BASE(today)} select s.id from s join charges ch on ch.id = s.id where ${STATUS_SQL} = 'faltando' order by ch.due_date limit 300`,
          [body.days],
        );
        return rows.map((r) => r.id);
      });
    }
    if (!ids.length) throw new AppError(409, 'conflict', 'Nenhuma cobrança pendente de lembrete.');
    const channels = await loadChannels(deps, me.orgId);
    const result = { queued: 0, manual: 0, skipped: 0, errors: [] as string[] };
    for (const id of ids) {
      for (const channel of (['whatsapp', 'email'] as const).filter((c) => (c === 'whatsapp' ? body.whatsapp : body.email))) {
        try {
          const r = await sendChargeMessage(deps, req, me, id, { channel, kind: 'manual', dispatch: false, skipIfQueued: true, channelsCache: channels });
          if (r.status === 'manual') result.manual++;
          else if (r.status === 'ja_na_fila') result.skipped++;
          else result.queued++;
        } catch (e) {
          result.skipped++;
          if (result.errors.length < 5 && e instanceof AppError) result.errors.push(e.message);
        }
      }
    }
    await asUser(deps, req, (db) => audit(db, req, 'reminders.bulk_send', 'charge', null, me.orgId, { charges: ids.length, ...result, errors: undefined }));
    // Primeiros envios já agora (respeitando o intervalo); o restante sai pela rotina automática.
    if (result.queued) await dispatchPending(deps, { deadline: Date.now() + 8000 }).catch(() => undefined);
    return { ...result, errors: [...new Set(result.errors)] };
  });
}
