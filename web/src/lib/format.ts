const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCompact = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact', maximumFractionDigits: 1 });

export const fmtDateTime = (v: string | null | undefined) => (v ? dateTime.format(new Date(v)) : '—');
export const fmtCents = (c: number | null | undefined) => (c === null || c === undefined ? '—' : brl.format(c / 100));
export const fmtCentsCompact = (c: number) => (Math.abs(c) >= 1_000_000 ? brlCompact.format(c / 100) : brl.format(c / 100));

/** Data pura "AAAA-MM-DD" → "DD/MM/AAAA" (sem conversão de fuso). */
export function fmtDate(v: string | null | undefined) {
  if (!v) return '—';
  const [y, m, d] = v.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export function datePill(v: string) {
  const [, m, d] = v.slice(0, 10).split('-');
  return { day: d!, month: MONTHS[Number(m) - 1]! };
}
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;

export function fmtPhone(v: string | null | undefined) {
  if (!v) return '—';
  const m = v.match(/^\+55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : v;
}

export function fmtDocument(v: string | null | undefined) {
  if (!v) return '—';
  if (v.length === 11) return v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (v.length === 14) return v.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return v;
}

export function relDays(days: number) {
  if (days === 0) return 'hoje';
  if (days === 1) return 'há 1 dia';
  if (days > 1) return `há ${days} dias`;
  if (days === -1) return 'amanhã';
  return `em ${-days} dias`;
}

export function daysFrom(today: string, date: string) {
  return Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
}

export function todayIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number) {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}

/** "1.500,00", "1500.5", "R$ 99" → centavos; null se inválido. */
export function parseMoneyToCents(v: string): number | null {
  let s = v.replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export const centsToInput = (c: number | null | undefined) => (c ? (c / 100).toFixed(2).replace('.', ',') : '');

export const intervalLabel: Record<number, string> = { 1: 'Mensal', 2: 'Bimestral', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };

export const methodLabel: Record<string, string> = {
  pix: 'PIX', dinheiro: 'Dinheiro', cartao: 'Cartão', boleto: 'Boleto', transferencia: 'Transferência', outro: 'Outro',
};

export const templateKindLabel: Record<string, string> = {
  lembrete: 'Lembrete (antes)',
  vencimento: 'No dia do vencimento',
  atraso: 'Atraso',
  pagamento_confirmado: 'Pagamento confirmado',
  personalizada: 'Personalizada',
};

export const segmentLabel: Record<string, string> = {
  academia: 'Academia', estudio: 'Estúdio (pilates, dança, lutas)', escola: 'Escola', curso: 'Curso livre',
  clinica: 'Clínica', consultorio: 'Consultório', salao: 'Salão / estética', condominio: 'Condomínio',
  associacao: 'Associação / clube', igreja: 'Igreja / instituição', coworking: 'Coworking', servicos: 'Prestação de serviços',
  software: 'Software / assinatura', outro: 'Outro',
};

export const roleLabel = { owner: 'Responsável', staff: 'Equipe' } as const;

export function offsetLabel(n: number) {
  if (n === 0) return 'No dia do vencimento';
  if (n < 0) return `${-n} dia${n === -1 ? '' : 's'} antes`;
  return `${n} dia${n === 1 ? '' : 's'} depois (atraso)`;
}

export function initials(name: string) {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[p.length - 1]![0] : '')).toUpperCase();
}
