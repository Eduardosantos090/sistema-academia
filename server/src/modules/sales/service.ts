import type { Deps } from '../../lib/context.js';
import { AppError, conflict } from '../../lib/errors.js';
import { hashPassword } from '../../lib/crypto.js';
import { OutboundError } from '../../lib/http.js';
import { decryptSecret } from '../../lib/secrets.js';
import { withTx } from '../../lib/db.js';
import { slugify, uniqueSlug } from '../platform/routes.js';
import {
  createCustomer,
  createSubscriptionCheckout,
  getCustomer,
  getSubscription,
  listSubscriptionsByCheckout,
  type AbacateSubscription,
} from '../payments/abacatepay.js';
import { createInvite } from '../auth/service.js';
import { deliverInvite } from '../users/routes.js';

export interface SaleConfig {
  apiKey: string | null;
  webhookSecret: string | null;
  enabled: boolean;
  productId: string | null;
  planName: string;
  priceCents: number;
  intervalMonths: number;
  methods: string[];
  /** Link de checkout fixo criado no painel da AbacatePay (opcional). */
  checkoutUrl: string | null;
  linkCheckedAt: Date | null;
}

export async function loadSaleConfig(deps: Deps): Promise<SaleConfig> {
  const { rows } = await deps.pools.owner.query('select * from platform_settings where id = 1');
  const r = rows[0];
  const key = deps.config.secretsKey;
  return {
    apiKey: decryptSecret(key, r?.abacate_api_key_enc),
    webhookSecret: decryptSecret(key, r?.abacate_webhook_secret_enc),
    enabled: !!r?.sale_enabled,
    productId: r?.sale_product_id ?? null,
    planName: r?.sale_plan_name ?? 'Venceu Mensal',
    priceCents: r?.sale_price_cents ?? 5000,
    intervalMonths: r?.sale_interval_months ?? 1,
    methods: r?.sale_methods ?? ['CARD'],
    checkoutUrl: r?.sale_checkout_url ?? null,
    linkCheckedAt: r?.sale_link_checked_at ?? null,
  };
}

export const saleAvailable = (c: SaleConfig) => c.enabled && !!c.apiKey && !!c.productId;

/**
 * Como a página de vendas vende: 'api' (cadastro no site + checkout criado pela
 * API, conta criada na hora), 'link' (botão abre o link fixo da AbacatePay) ou
 * 'none' (só o formulário de contato).
 */
export function saleMode(c: SaleConfig): 'api' | 'link' | 'none' {
  if (saleAvailable(c)) return 'api';
  return c.checkoutUrl ? 'link' : 'none';
}

/** Id do checkout (bill_...) do link fixo. */
export const linkCheckoutId = (c: SaleConfig) => c.checkoutUrl?.split('/').pop() ?? null;

export interface SignupInput {
  ownerName: string;
  businessName: string;
  segment: string;
  email: string;
  phone: string | null;
  document: string | null;
  password: string;
}

/** Inicia o cadastro: guarda os dados e cria o checkout de assinatura na AbacatePay. */
export async function startSignup(deps: Deps, input: SignupInput) {
  const cfg = await loadSaleConfig(deps);
  if (!saleAvailable(cfg)) throw new AppError(409, 'conflict', 'A contratação online está indisponível no momento. Fale com a gente pelo formulário.');
  const exists = await deps.pools.owner.query('select 1 from users where email = $1', [input.email]);
  if (exists.rowCount) throw conflict('Este e-mail já tem uma conta no Venceu. Entre com ele ou use "Esqueci minha senha".');
  const passwordHash = await hashPassword(input.password);
  const { rows } = await deps.pools.owner.query<{ id: string; token: string }>(
    `insert into signups (owner_name, business_name, segment, email, phone, document, password_hash)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, token`,
    [input.ownerName, input.businessName, input.segment, input.email, input.phone, input.document, passwordHash],
  );
  const s = rows[0]!;
  try {
    const customer = await createCustomer(deps, cfg.apiKey!, {
      email: input.email,
      name: input.ownerName,
      cellphone: input.phone,
      taxId: input.document,
    });
    const checkout = await createSubscriptionCheckout(deps, cfg.apiKey!, {
      productId: cfg.productId!,
      customerId: customer.id,
      externalId: s.id,
      completionUrl: `${deps.config.appUrl}/assinar/concluido?t=${s.token}`,
      returnUrl: `${deps.config.appUrl}/assinar`,
      methods: cfg.methods,
    });
    await deps.pools.owner.query(
      'update signups set abacate_customer_id = $2, checkout_id = $3, checkout_url = $4 where id = $1',
      [s.id, customer.id, checkout.id, checkout.url],
    );
    return { token: s.token, url: checkout.url };
  } catch (e) {
    const msg = e instanceof OutboundError ? e.message : 'Falha ao criar o pagamento.';
    await deps.pools.owner.query(`update signups set status = 'expirado', error = $2, password_hash = null where id = $1`, [s.id, msg.slice(0, 300)]);
    throw new AppError(502, 'provider', 'Não foi possível abrir o pagamento agora. Tente novamente em alguns minutos.');
  }
}

/**
 * Cria a organização e o acesso do responsável depois do pagamento confirmado
 * (assinatura ATIVA consultada na AbacatePay). Idempotente.
 */
export async function provisionSignup(deps: Deps, signupId: string, sub: AbacateSubscription) {
  if (sub.status !== 'ACTIVE') return null;
  const cfg = await loadSaleConfig(deps);
  const slug = await uniqueSlug(deps, slugify((await deps.pools.owner.query('select business_name from signups where id = $1', [signupId])).rows[0]?.business_name ?? 'empresa'));
  return withTx(deps.pools.owner, async (db) => {
    const { rows } = await db.query(`select * from signups where id = $1 for update`, [signupId]);
    const s = rows[0];
    if (!s || s.status === 'ativo') return s?.organization_id ?? null;
    if (s.checkout_id && sub.checkoutId && s.checkout_id !== sub.checkoutId) return null;
    const taken = await db.query('select 1 from users where email = $1', [s.email]);
    if (taken.rowCount) {
      await db.query(`update signups set error = 'E-mail já usado por outra conta: fale com o suporte.', subscription_id = $2 where id = $1`, [s.id, sub.id]);
      return null;
    }
    const org = await db.query<{ id: string }>(
      `insert into organizations (name, slug, segment, contact_email, contact_phone, document,
                                  plan_name, plan_amount_cents, plan_interval_months, access_until, auto_suspend,
                                  abacate_subscription_id, subscription_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::smallint, ((now() at time zone 'America/Sao_Paulo')::date + make_interval(months => $9::int))::date, true, $10, 'ativa')
       returning id`,
      [s.business_name, slug, s.segment, s.email, s.phone, s.document, cfg.planName, Number.isFinite(sub.amount) && sub.amount > 0 ? sub.amount : cfg.priceCents,
        cfg.intervalMonths, sub.id],
    );
    const orgId = org.rows[0]!.id;
    await db.query('select app.seed_org_defaults($1)', [orgId]);
    const u = await db.query<{ id: string }>(
      `insert into users (email, full_name, organization_id, role) values ($1, $2, $3, 'owner') returning id`,
      [s.email, s.owner_name, orgId],
    );
    if (s.password_hash) await db.query('insert into user_credentials (user_id, password_hash) values ($1, $2)', [u.rows[0]!.id, s.password_hash]);
    await db.query(
      `update signups set status = 'ativo', organization_id = $2, subscription_id = $3, activated_at = now(), password_hash = null, error = null where id = $1`,
      [s.id, orgId, sub.id],
    );
    await db.query(
      `insert into audit_events (organization_id, action, entity_type, entity_id, details) values ($1::uuid, 'sale.signup_activated', 'organization', $1::text, $2)`,
      [orgId, JSON.stringify({ subscription: sub.id, method: sub.method, devMode: sub.devMode })],
    );
    return orgId;
  });
}

/**
 * Assinatura paga pelo link fixo (sem cadastro prévio no site): cria a conta
 * com os dados do cliente consultados na AbacatePay e envia o convite de
 * acesso (ou deixa o link de convite disponível no painel da plataforma).
 */
export async function provisionFromLink(deps: Deps, apiKey: string, sub: AbacateSubscription) {
  if (sub.status !== 'ACTIVE' || !sub.customerId) return null;
  const known = await deps.pools.owner.query(
    'select 1 from organizations where abacate_subscription_id = $1 union all select 1 from signups where subscription_id = $1',
    [sub.id],
  );
  if (known.rowCount) return null;
  const cust = await getCustomer(deps, apiKey, sub.customerId);
  const email = cust.email?.toLowerCase() ?? null;
  const name = cust.name && cust.name.length >= 2 ? cust.name : email ? email.split('@')[0]!.slice(0, 120) : 'Cliente';
  const business = name.length >= 2 ? name : 'Nova empresa';
  const phone = cust.cellphone ? normalizeBrPhone(cust.cellphone) : null;
  const doc = cust.taxId && /^\d{11}$|^\d{14}$/.test(cust.taxId.replace(/\D/g, '')) ? cust.taxId.replace(/\D/g, '') : null;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    await deps.pools.owner.query(
      `insert into signups (owner_name, business_name, email, status, source, subscription_id, abacate_customer_id, checkout_id, error)
       values ($1, $2, 'sem-email@invalido.local', 'pendente', 'link', $3, $4, null, 'Cliente sem e-mail na AbacatePay: crie a conta manualmente.')
       on conflict do nothing`,
      [name.padEnd(2, '-'), business.padEnd(2, '-'), sub.id, sub.customerId],
    );
    return null;
  }
  const { rows } = await deps.pools.owner.query<{ id: string }>(
    `insert into signups (owner_name, business_name, email, phone, document, source, abacate_customer_id, subscription_id)
     values ($1, $2, $3, $4, $5, 'link', $6, $7)
     on conflict (subscription_id) do nothing returning id`,
    [name.padEnd(2, '-'), business.padEnd(2, '-'), email, phone, doc, sub.customerId, sub.id],
  );
  if (!rows[0]) return null;
  const orgId = await provisionSignup(deps, rows[0].id, sub);
  if (orgId) {
    const u = await deps.pools.owner.query<{ id: string }>(`select id from users where organization_id = $1 and role = 'owner' limit 1`, [orgId]);
    if (u.rows[0] && deps.config.mailMode !== 'manual') {
      const token = await withTx(deps.pools.owner, (db) => createInvite(deps, db, u.rows[0]!.id, null));
      await deliverInvite(deps, email, name, token).catch(() => undefined);
    }
  }
  return orgId;
}

function normalizeBrPhone(raw: string) {
  const d = raw.replace(/\D/g, '');
  const full = d.length === 10 || d.length === 11 ? `55${d}` : d;
  return /^55\d{10,11}$/.test(full) ? `+${full}` : null;
}

/** Renovação paga: estende o acesso por um período (limitado a um período a partir de hoje). */
export async function renewSubscription(deps: Deps, sub: AbacateSubscription) {
  if (sub.status !== 'ACTIVE') return false;
  const { rows } = await deps.pools.owner.query<{ id: string }>(
    `update organizations o set
        access_until = least(greatest(coalesce(o.access_until, t.today), t.today) + make_interval(months => o.plan_interval_months),
                             t.today + make_interval(months => o.plan_interval_months) + interval '7 days')::date,
        is_active = case when o.suspended_reason = 'inadimplencia' then true else o.is_active end,
        suspended_reason = case when o.suspended_reason = 'inadimplencia' then null else o.suspended_reason end,
        subscription_status = 'ativa'
       from (select (now() at time zone 'America/Sao_Paulo')::date as today) t
      where o.abacate_subscription_id = $1
      returning o.id`,
    [sub.id],
  );
  for (const r of rows) {
    await deps.pools.owner.query(
      `insert into audit_events (organization_id, action, entity_type, entity_id, details) values ($1::uuid, 'sale.subscription_renewed', 'organization', $1::text, $2)`,
      [r.id, JSON.stringify({ subscription: sub.id })],
    );
  }
  return rows.length > 0;
}

/** Cancelada: o acesso continua até o fim do período pago e depois é suspenso pela rotina. */
export async function cancelSubscription(deps: Deps, sub: AbacateSubscription) {
  if (sub.status !== 'CANCELLED') return false;
  const { rows } = await deps.pools.owner.query<{ id: string }>(
    `update organizations set subscription_status = 'cancelada', auto_suspend = true where abacate_subscription_id = $1 returning id`,
    [sub.id],
  );
  for (const r of rows) {
    await deps.pools.owner.query(
      `insert into audit_events (organization_id, action, entity_type, entity_id, details) values ($1::uuid, 'sale.subscription_cancelled', 'organization', $1::text, $2)`,
      [r.id, JSON.stringify({ subscription: sub.id })],
    );
  }
  return rows.length > 0;
}

const SUB_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * Evento de assinatura recebido da AbacatePay. O conteúdo só indica QUAL
 * assinatura mudou; a situação é sempre consultada na API antes de agir.
 */
export async function handleSubscriptionEvent(deps: Deps, apiKey: string, body: unknown) {
  const b = body as { id?: unknown; event?: unknown; data?: { subscription?: { id?: unknown } } };
  const event = typeof b?.event === 'string' ? b.event : '';
  const subId = b?.data?.subscription?.id;
  if (!event.startsWith('subscription.') || typeof subId !== 'string' || !SUB_ID.test(subId)) return { handled: false };
  const eventId = typeof b.id === 'string' && SUB_ID.test(b.id) ? b.id : null;
  if (eventId) {
    const seen = await deps.pools.owner.query(`select 1 from webhook_events where provider = 'abacatepay' and event_id = $1`, [eventId]);
    if (seen.rowCount) return { handled: true, duplicate: true };
  }
  const sub = await getSubscription(deps, apiKey, { id: subId });
  let result: unknown = null;
  if (event === 'subscription.completed' || event === 'subscription.trial_started') {
    const s = await deps.pools.owner.query<{ id: string }>(
      `select id from signups where (checkout_id = $1 and $1 is not null) or subscription_id = $2 limit 1`,
      [sub.checkoutId, sub.id],
    );
    if (s.rows[0]) result = await provisionSignup(deps, s.rows[0].id, sub);
    else if (sub.checkoutId && sub.checkoutId === linkCheckoutId(await loadSaleConfig(deps))) result = await provisionFromLink(deps, apiKey, sub);
  } else if (event === 'subscription.renewed') {
    result = await renewSubscription(deps, sub);
  } else if (event === 'subscription.cancelled') {
    result = await cancelSubscription(deps, sub);
  }
  if (eventId) {
    await deps.pools.owner.query(`insert into webhook_events (provider, event_id) values ('abacatepay', $1) on conflict do nothing`, [eventId]);
  }
  return { handled: true, event, result: result ?? null };
}

/** Confere um cadastro pendente direto na AbacatePay (rede de segurança sem webhook). */
export async function checkSignup(deps: Deps, apiKey: string, s: { id: string; checkout_id: string | null }) {
  try {
    const sub = await getSubscription(deps, apiKey, { externalId: s.id });
    if (sub.status === 'ACTIVE' && (!s.checkout_id || !sub.checkoutId || sub.checkoutId === s.checkout_id)) {
      return await provisionSignup(deps, s.id, sub);
    }
  } catch {
    /* ainda sem assinatura (não pago) ou falha temporária */
  }
  await deps.pools.owner.query('update signups set checked_at = now() where id = $1', [s.id]);
  return null;
}

/** Rotina periódica: confere cadastros pendentes e expira os abandonados. */
export async function pollSignups(deps: Deps, limit = 10) {
  await deps.pools.owner.query(
    `update signups set status = 'expirado', password_hash = null where status = 'pendente' and created_at < now() - interval '3 days'`,
  );
  const cfg = await loadSaleConfig(deps);
  if (!cfg.apiKey) return { checked: 0, activated: 0 };
  const { rows } = await deps.pools.owner.query<{ id: string; checkout_id: string | null }>(
    `select id, checkout_id from signups
      where status = 'pendente' and checkout_id is not null and created_at > now() - interval '3 days'
        and (checked_at is null or checked_at < now() - interval '3 minutes')
      order by checked_at nulls first limit $1`,
    [limit],
  );
  let activated = 0;
  for (const s of rows) if (await checkSignup(deps, cfg.apiKey, s)) activated++;
  // Link fixo: a cada 5 minutos, procura assinaturas novas pagas por ele.
  const bill = linkCheckoutId(cfg);
  if (bill && (!cfg.linkCheckedAt || Date.now() - cfg.linkCheckedAt.getTime() > 5 * 60_000)) {
    await deps.pools.owner.query('update platform_settings set sale_link_checked_at = now() where id = 1');
    try {
      for (const sub of (await listSubscriptionsByCheckout(deps, cfg.apiKey, bill)).slice(0, 20)) {
        if (await provisionFromLink(deps, cfg.apiKey, sub)) activated++;
      }
    } catch {
      /* falha temporária: tenta na próxima rodada */
    }
  }
  return { checked: rows.length, activated };
}
