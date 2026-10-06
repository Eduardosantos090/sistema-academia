/**
 * Modelos de mensagem com variáveis {{nome}}. Texto puro (WhatsApp e e-mail
 * em texto): nenhum HTML é interpretado.
 */
export const TEMPLATE_VARS = {
  nome: 'Nome completo do cliente',
  primeiro_nome: 'Primeiro nome do cliente',
  valor: 'Valor da cobrança',
  valor_pago: 'Valor pago (confirmação de pagamento)',
  vencimento: 'Data de vencimento',
  descricao: 'Descrição da cobrança',
  dias_atraso: 'Dias em atraso',
  empresa: 'Nome da sua empresa',
  pix: 'Chave PIX',
  link_pagamento: 'Link de pagamento da cobrança',
  instrucoes_pagamento: 'PIX, link e instruções de pagamento',
  telefone_empresa: 'Telefone da empresa',
} as const;

export type TemplateVar = keyof typeof TEMPLATE_VARS;
export type TemplateValues = Partial<Record<TemplateVar, string>>;

const VAR_RE = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

export function unknownVariables(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(VAR_RE)) if (!(m[1]! in TEMPLATE_VARS)) out.add(m[1]!);
  return [...out];
}

/** Variáveis na ordem em que aparecem (parâmetros {{1}}, {{2}}… do modelo da Meta). */
export function variablesInOrder(body: string): TemplateVar[] {
  return [...body.matchAll(VAR_RE)].map((m) => m[1] as TemplateVar).filter((v) => v in TEMPLATE_VARS);
}

export function renderTemplate(body: string, values: TemplateValues): string {
  return body
    .replace(VAR_RE, (_, name: string) => (name in TEMPLATE_VARS ? (values[name as TemplateVar] ?? '') : ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatCents = (c: number) => brl.format(c / 100).replace(/\u00a0/g, ' ');

/** "2026-10-09" → "09/10/2026" (data pura, sem fuso). */
export function formatDate(d: string | Date): string {
  const iso = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  const [y, m, day] = iso.split('-');
  return `${day}/${m}/${y}`;
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}

export function formatPhoneBr(e164: string | null | undefined) {
  if (!e164) return '';
  const m = e164.match(/^\+55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export interface OrgPaymentInfo {
  name: string;
  pix_key: string | null;
  payment_instructions: string | null;
  contact_phone: string | null;
}

export function paymentInstructions(org: OrgPaymentInfo, paymentLink?: string | null) {
  const parts: string[] = [];
  if (org.pix_key) parts.push(`💠 PIX: ${org.pix_key}`);
  if (paymentLink) parts.push(`🔗 Pague pelo link: ${paymentLink}`);
  if (org.payment_instructions) parts.push(org.payment_instructions);
  return parts.join('\n');
}

export interface ChargeForTemplate {
  description: string;
  amount_cents: number;
  due_date: string | Date;
  payment_link: string | null;
  paid_amount_cents?: number | null;
}

export function chargeValues(
  org: OrgPaymentInfo,
  customer: { name: string },
  charge: ChargeForTemplate,
  today: string,
): TemplateValues {
  const due = typeof charge.due_date === 'string' ? charge.due_date.slice(0, 10) : charge.due_date.toISOString().slice(0, 10);
  const late = Math.max(0, Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000));
  return {
    nome: customer.name,
    primeiro_nome: firstName(customer.name),
    valor: formatCents(charge.amount_cents),
    valor_pago: formatCents(charge.paid_amount_cents ?? charge.amount_cents),
    vencimento: formatDate(due),
    descricao: charge.description,
    dias_atraso: String(late),
    empresa: org.name,
    pix: org.pix_key ?? '',
    link_pagamento: charge.payment_link ?? '',
    instrucoes_pagamento: paymentInstructions(org, charge.payment_link),
    telefone_empresa: formatPhoneBr(org.contact_phone),
  };
}
