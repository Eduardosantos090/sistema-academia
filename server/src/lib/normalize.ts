import { z } from 'zod';

/** Remove espaços extras e caracteres de controle. */
export function cleanText(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

export function normalizeEmail(v: string): string {
  return cleanText(v).toLowerCase();
}

/**
 * Normaliza telefone para dígitos com "+" opcional. Números brasileiros com
 * 10 ou 11 dígitos recebem o prefixo +55.
 */
export function normalizePhone(v: string): string | null {
  const raw = cleanText(v);
  if (!raw) return null;
  const plus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!plus && digits.startsWith('0')) digits = digits.replace(/^0+/, '');
  if (!plus && (digits.length === 10 || digits.length === 11)) return `+55${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

export const zText = (min: number, max: number) =>
  z.string().transform(cleanText).pipe(z.string().min(min, 'Campo obrigatório.').max(max, `Máximo de ${max} caracteres.`));

export const zOptionalText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => (v == null ? null : cleanText(v) || null))
    .pipe(z.string().max(max, `Máximo de ${max} caracteres.`).nullable());

export const zEmail = z
  .string()
  .transform(normalizeEmail)
  .pipe(z.string().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'E-mail inválido.'));

export const zOptionalEmail = z
  .string()
  .nullish()
  .transform((v) => (v == null ? null : normalizeEmail(v) || null))
  .pipe(z.string().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'E-mail inválido.').nullable());

export const zOptionalPhone = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v == null || !cleanText(v)) return null;
    const p = normalizePhone(v);
    if (!p) {
      ctx.addIssue({ code: 'custom', message: 'Telefone inválido.' });
      return z.NEVER;
    }
    return p;
  });

export const zUuid = z.string().uuid('Identificador inválido.');

export const zPassword = z
  .string()
  .min(10, 'A senha deve ter ao menos 10 caracteres.')
  .max(128, 'A senha deve ter no máximo 128 caracteres.');

export const zPage = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(20),
});

/** Padrão seguro para ILIKE: escapa curingas digitados pelo usuário. */
export function likePattern(q: string): string {
  return `%${cleanText(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Variações de um número brasileiro com e sem o nono dígito: o WhatsApp
 * identifica alguns celulares antigos sem o 9 (ex.: 55 47 8840-4285).
 */
export function phoneVariants(e164: string): string[] {
  const m = e164.match(/^\+55(\d{2})(\d{8,9})$/);
  if (!m) return [e164];
  const [, ddd, local] = m as unknown as [string, string, string];
  if (local.length === 9 && local.startsWith('9')) return [e164, `+55${ddd}${local.slice(1)}`];
  if (local.length === 8) return [e164, `+55${ddd}9${local}`];
  return [e164];
}

/** Link "clique para conversar" do WhatsApp com texto preenchido. */
export function waMeLink(e164: string, text: string): string {
  return `https://wa.me/${e164.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

/** CPF (11) ou CNPJ (14) somente com dígitos, com dígitos verificadores válidos. */
export function normalizeDocument(v: string): string | null {
  const d = v.replace(/\D/g, '');
  if (d.length === 11) return validCpf(d) ? d : null;
  if (d.length === 14) return validCnpj(d) ? d : null;
  return null;
}

function validCpf(c: string) {
  if (/^(\d)\1{10}$/.test(c)) return false;
  const calc = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += Number(c[i]) * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

function validCnpj(c: string) {
  if (/^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => {
    const w = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = w.reduce((acc, wi, i) => acc + wi * Number(c[i]), 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

export const zOptionalDocument = z
  .string()
  .nullish()
  .transform((v, ctx) => {
    if (v == null || !cleanText(v)) return null;
    const d = normalizeDocument(v);
    if (!d) {
      ctx.addIssue({ code: 'custom', message: 'CPF ou CNPJ inválido.' });
      return z.NEVER;
    }
    return d;
  });

export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '2000-01-01' && v <= '2100-12-31';
}, 'Data inválida.');

export const zCents = z.coerce.number().int('Valor inválido.').min(1, 'Informe um valor maior que zero.').max(100_000_000, 'Valor acima do limite.');

export const zHttpsUrl = z
  .string()
  .nullish()
  .transform((v) => (v == null ? null : cleanText(v) || null))
  .pipe(
    z
      .string()
      .max(500)
      .regex(/^https:\/\/[^\s<>"']+$/, 'Use um link https:// válido.')
      .nullable(),
  );
