import type { Deps } from '../../lib/context.js';
import { withTx, type Db } from '../../lib/db.js';
import { phoneVariants } from '../../lib/normalize.js';
import type { MediaRef } from '../../lib/media.js';
import { firstName, formatCents, formatDate, paymentInstructions, renderTemplate } from '../../lib/template.js';

/**
 * Assistente virtual (chatbot) por regras — previsível, sem custo por
 * mensagem e sem enviar dados dos clientes a serviços de IA de terceiros.
 *
 * Entende números do menu, palavras-chave e as respostas personalizadas da
 * organização. Não substitui o atendimento humano: o cliente pode pedir um
 * atendente a qualquer momento e o bot silencia até a equipe devolver a
 * conversa ao modo automático.
 */

export interface BotOrg {
  id: string;
  name: string;
  slug: string;
  pix_key: string | null;
  payment_instructions: string | null;
  contact_phone: string | null;
  bot_enabled: boolean;
  bot_greeting: string | null;
  today: string;
}

interface BotCustomer {
  id: string;
  name: string;
}

interface OpenCharge {
  id: string;
  customer_name: string;
  description: string;
  amount_cents: number;
  due_date: string;
  payment_link: string | null;
}

interface BotAnswer {
  keywords: string[];
  answer: string;
  media?: MediaRef | null;
}

export type Intent = 'menu' | 'vencimentos' | 'pagamento' | 'ja_paguei' | 'atendente' | 'sair' | 'reativar' | 'faq' | 'nao_entendi';

export interface BotDecision {
  intent: Intent;
  replies: string[];
  /** Anexo enviado junto com a resposta (respostas personalizadas com imagem, áudio ou PDF). */
  media?: MediaRef | null;
  actions: {
    handoff?: boolean;
    backToBot?: boolean;
    optOut?: boolean;
    optIn?: boolean;
    reportPaid?: string[];
  };
}

/** Minúsculas, sem acentos, sem pontuação e com espaços simples. */
export function normalizeText(t: string) {
  return t
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const has = (text: string, re: RegExp) => re.test(` ${text} `);

const RE = {
  menu: /^(0|menu|inicio|oi+|ola|opa|bom dia|boa tarde|boa noite|hey|hello|eai|e ai)$/,
  sair: /^(sair|parar|pare|stop|descadastrar|cancelar avisos|nao quero mais receber)$/,
  reativar: /^(receber avisos|ativar avisos|voltar a receber)$/,
  jaPaguei: / (paguei|ja pag\w*|ja esta pago|comprovante|efetuei|transferi|fiz o pix|fiz o pagamento|pagamento feito|ta pago|esta pago) /,
  vencimentos: / (venc\w*|fatura\w*|mensalidade\w*|devo|debito\w*|boleto\w*|em aberto|pendente\w*|parcela\w*|cobranca\w*|quanto (e|eh|custa|falta)|valor) /,
  pagamento: / (pix|pagar|pagamento|chave|link|transferencia|como pago|forma de pagamento|conta bancaria) /,
  atendente: / (atendente|humano|pessoa|falar com|suporte|ajuda|reclamacao|duvida) /,
};

export function menuText(org: BotOrg, customer: BotCustomer | null) {
  const greeting = org.bot_greeting
    ? renderTemplate(org.bot_greeting, { empresa: org.name, primeiro_nome: customer ? firstName(customer.name) : '', nome: customer?.name ?? '' })
    : `Olá${customer ? `, ${firstName(customer.name)}` : ''}! 👋 Sou o assistente virtual da ${org.name}.`;
  return (
    `${greeting}\n\nComo posso ajudar? Responda com o número:\n` +
    '1️⃣ Meus vencimentos\n' +
    '2️⃣ Dados para pagamento\n' +
    '3️⃣ Já paguei\n' +
    '4️⃣ Falar com um atendente'
  );
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function chargeLine(c: OpenCharge, today: string, many: boolean) {
  const late = daysBetween(c.due_date, today);
  const status = late > 0 ? ` ⚠️ em atraso há ${late} dia(s)` : late === 0 ? ' — vence hoje' : '';
  const who = many ? ` (${firstName(c.customer_name)})` : '';
  return `• ${c.description}${who} — ${formatCents(c.amount_cents)} — vence ${formatDate(c.due_date)}${status}`;
}

const NOT_FOUND =
  'Não encontrei um cadastro com este número de WhatsApp. 🤔\nDigite 4 para falar com um atendente.';

/** Decide a resposta (sem efeitos colaterais). */
export function decide(
  org: BotOrg,
  customers: BotCustomer[],
  charges: OpenCharge[],
  answers: BotAnswer[],
  rawText: string,
): BotDecision {
  const text = normalizeText(rawText);
  const customer = customers[0] ?? null;
  const many = new Set(charges.map((c) => c.customer_name)).size > 1;

  if (!text || RE.menu.test(text)) {
    return { intent: 'menu', replies: [menuText(org, customer)], actions: { backToBot: true } };
  }
  if (RE.sair.test(text)) {
    return {
      intent: 'sair',
      replies: [
        'Pronto. Você não vai mais receber lembretes automáticos por WhatsApp. ✅\nSe mudar de ideia, envie "receber avisos".',
      ],
      actions: { optOut: true },
    };
  }
  if (RE.reativar.test(text)) {
    return { intent: 'reativar', replies: ['Combinado! Você voltará a receber os lembretes por WhatsApp. 🔔'], actions: { optIn: true } };
  }

  const byNumber: Record<string, Intent> = { '1': 'vencimentos', '2': 'pagamento', '3': 'ja_paguei', '4': 'atendente' };
  let intent: Intent | null = byNumber[text] ?? null;

  if (!intent && has(text, RE.jaPaguei)) intent = 'ja_paguei';
  if (!intent) {
    const faq = answers.find((a) =>
      a.keywords.some((k) => {
        const nk = normalizeText(k);
        return nk && ` ${text} `.includes(` ${nk} `);
      }),
    );
    if (faq) return { intent: 'faq', replies: [faq.answer], media: faq.media ?? null, actions: {} };
  }
  if (!intent && has(text, RE.atendente)) intent = 'atendente';
  if (!intent && has(text, RE.vencimentos)) intent = 'vencimentos';
  if (!intent && has(text, RE.pagamento)) intent = 'pagamento';

  switch (intent) {
    case 'vencimentos': {
      if (!customer) return { intent, replies: [NOT_FOUND], actions: {} };
      if (!charges.length) {
        return { intent, replies: [`✅ Tudo certo, ${firstName(customer.name)}! Você não tem cobranças em aberto.`], actions: {} };
      }
      const shown = charges.slice(0, 6);
      const total = charges.reduce((s, c) => s + c.amount_cents, 0);
      const lines = shown.map((c) => chargeLine(c, org.today, many)).join('\n');
      const more = charges.length > shown.length ? `\n…e mais ${charges.length - shown.length}.` : '';
      const sum = charges.length > 1 ? `\n\nTotal em aberto: ${formatCents(total)}` : '';
      return {
        intent,
        replies: [`📋 Seus vencimentos em aberto:\n${lines}${more}${sum}\n\nDigite 2 para ver os dados de pagamento.`],
        actions: {},
      };
    }
    case 'pagamento': {
      const link = charges.find((c) => c.payment_link)?.payment_link ?? null;
      const info = paymentInstructions(org, link);
      return {
        intent,
        replies: [
          info
            ? `💳 Dados para pagamento — ${org.name}\n\n${info}\n\nDepois de pagar, digite 3 para nos avisar.`
            : 'Para receber os dados de pagamento, digite 4 e fale com um atendente.',
        ],
        actions: {},
      };
    }
    case 'ja_paguei': {
      if (!customer) return { intent, replies: [NOT_FOUND], actions: {} };
      // Cobranças vencidas ou próximas do vencimento.
      const relevant = charges.filter((c) => daysBetween(org.today, c.due_date) <= 7);
      if (!relevant.length) {
        return {
          intent,
          replies: ['Não encontrei cobranças pendentes para confirmar. 👍 Se precisar, digite 4 para falar com um atendente.'],
          actions: {},
        };
      }
      const lines = relevant.slice(0, 6).map((c) => chargeLine(c, org.today, many)).join('\n');
      return {
        intent,
        replies: [
          `Obrigado! 🙌 Registramos seu aviso de pagamento de:\n${lines}\n\nNossa equipe vai conferir e confirmar em breve. Se quiser, envie o comprovante por aqui.`,
        ],
        actions: { reportPaid: relevant.map((c) => c.id) },
      };
    }
    case 'atendente':
      return {
        intent,
        replies: ['Certo! 👍 Um atendente vai continuar a conversa por aqui em breve.\nPara voltar ao menu automático, digite 0.'],
        actions: { handoff: true },
      };
    default:
      return { intent: 'nao_entendi', replies: [`Desculpe, não entendi. 🤔\n\n${menuText(org, customer)}`], actions: {} };
  }
}

async function loadContext(db: Db, orgId: string, customerIds: string[]) {
  const charges = customerIds.length
    ? (
        await db.query<OpenCharge>(
          `select c.id, cu.name as customer_name, c.description, c.amount_cents,
                  to_char(c.due_date, 'YYYY-MM-DD') as due_date, c.payment_link
             from charges c join customers cu on cu.id = c.customer_id
            where c.organization_id = $1 and c.customer_id = any($2::uuid[]) and c.status = 'aberta'
            order by c.due_date limit 20`,
          [orgId, customerIds],
        )
      ).rows
    : [];
  const answers = (
    await db.query<{ keywords: string[]; answer: string; media_id: string | null; token: string | null; name: string | null; mime: string | null }>(
      `select a.keywords, a.answer, a.media_id, mf.token, mf.name, mf.mime
         from bot_answers a left join media_files mf on mf.id = a.media_id
        where a.organization_id = $1 and a.is_active order by a.created_at`,
      [orgId],
    )
  ).rows.map((r) => ({
    keywords: r.keywords,
    answer: r.answer,
    media: r.media_id && r.token ? { id: r.media_id, token: r.token, name: r.name!, mime: r.mime! } : null,
  }));
  return { charges, answers };
}

export async function loadBotOrg(db: Db | Deps['pools']['owner'], where: { id?: string; webhookId?: string }) {
  const { rows } = await db.query<BotOrg & { is_active: boolean }>(
    `select id, name, slug, pix_key, payment_instructions, contact_phone, bot_enabled, bot_greeting, is_active,
            to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as today
       from organizations where ${where.id ? 'id = $1' : 'webhook_id = $1'}`,
    [where.id ?? where.webhookId],
  );
  return rows[0] ?? null;
}

/** Simulação no painel: mesma lógica, sem gravar nem enviar nada. */
export async function simulate(deps: Deps, org: BotOrg, customerId: string | null, text: string) {
  return withTx(deps.pools.owner, async (db) => {
    const customers = customerId
      ? (await db.query<BotCustomer>('select id, name from customers where id = $1 and organization_id = $2', [customerId, org.id])).rows
      : [];
    const ctx = await loadContext(db, org.id, customers.map((c) => c.id));
    return decide(org, customers, ctx.charges, ctx.answers, text);
  });
}

const LOOP_LIMIT_PER_MINUTE = 12;

/**
 * Mensagem recebida do cliente (WhatsApp). Grava a conversa, aplica a
 * decisão do assistente e devolve as respostas a enviar (vazio quando a
 * conversa está com um atendente, o bot está desligado ou é reentrega).
 */
export async function handleIncoming(
  deps: Deps,
  org: BotOrg,
  phone: string,
  text: string,
  providerId: string | null,
): Promise<{ replies: string[]; media: MediaRef | null; conversationId: string; intent: Intent | null }> {
  return withTx(deps.pools.owner, async (db) => {
    const variants = phoneVariants(phone);
    const customers = (
      await db.query<BotCustomer>(
        `select id, name from customers
          where organization_id = $1 and phone = any($2::text[]) and is_active
          order by created_at`,
        [org.id, variants],
      )
    ).rows;

    const conv = (
      await db.query<{ id: string; status: 'bot' | 'humano' | 'encerrada' }>(
        `insert into conversations (organization_id, phone, customer_id)
         values ($1, $2, $3)
         on conflict (organization_id, phone) do update
           set last_message_at = now(), customer_id = coalesce(conversations.customer_id, excluded.customer_id)
         returning id, status`,
        [org.id, phone, customers[0]?.id ?? null],
      )
    ).rows[0]!;

    const inserted = await db.query(
      `insert into chat_messages (organization_id, conversation_id, direction, author, body, provider_id)
       values ($1, $2, 'in', 'cliente', $3, $4)
       on conflict (organization_id, provider_id) where provider_id is not null do nothing`,
      [org.id, conv.id, text.slice(0, 4096) || '[mensagem vazia]', providerId],
    );
    if (!inserted.rowCount) return { replies: [], media: null, conversationId: conv.id, intent: null }; // reentrega do provedor

    const recent = await db.query<{ n: number }>(
      `select count(*)::int as n from chat_messages
        where conversation_id = $1 and direction = 'in' and created_at > now() - interval '1 minute'`,
      [conv.id],
    );
    const flooding = recent.rows[0]!.n > LOOP_LIMIT_PER_MINUTE;
    const normalized = normalizeText(text);
    const wantsMenu = normalized === '0' || normalized === 'menu';

    if (!org.bot_enabled || flooding || (conv.status === 'humano' && !wantsMenu)) {
      await db.query('update conversations set unread = unread + 1 where id = $1', [conv.id]);
      return { replies: [], media: null, conversationId: conv.id, intent: null };
    }

    const ctx = await loadContext(db, org.id, customers.map((c) => c.id));
    const d = decide(org, customers, ctx.charges, ctx.answers, text);
    const ids = customers.map((c) => c.id);

    if (d.actions.optOut && ids.length) {
      await db.query('update customers set whatsapp_opt_in = false where id = any($1::uuid[])', [ids]);
      await db.query(
        `update messages set status = 'cancelada', error = 'Cliente pediu para não receber mensagens.'
          where organization_id = $1 and customer_id = any($2::uuid[]) and channel = 'whatsapp' and status in ('pendente', 'manual')`,
        [org.id, ids],
      );
    }
    if (d.actions.optIn && ids.length) {
      await db.query('update customers set whatsapp_opt_in = true where id = any($1::uuid[])', [ids]);
    }
    if (d.actions.reportPaid?.length) {
      await db.query(
        `update charges set reported_paid_at = now()
          where id = any($1::uuid[]) and organization_id = $2 and status = 'aberta'`,
        [d.actions.reportPaid, org.id],
      );
    }
    const status = d.actions.handoff ? 'humano' : conv.status === 'humano' && !d.actions.backToBot ? 'humano' : 'bot';
    const attention = d.actions.handoff || (d.actions.reportPaid?.length ?? 0) > 0;
    await db.query(
      `update conversations set status = $2, unread = case when $3 then unread + 1 else unread end where id = $1`,
      [conv.id, status, attention],
    );
    for (const [i, r] of d.replies.entries()) {
      await db.query(
        `insert into chat_messages (organization_id, conversation_id, direction, author, body, media_id)
         values ($1, $2, 'out', 'bot', $3, $4)`,
        [org.id, conv.id, r.slice(0, 4096), i === 0 ? (d.media?.id ?? null) : null],
      );
    }
    return { replies: d.replies, media: d.media ?? null, conversationId: conv.id, intent: d.intent };
  });
}
