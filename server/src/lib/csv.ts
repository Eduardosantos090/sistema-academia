/**
 * Geração de CSV para abrir no Excel brasileiro: separador ";", BOM UTF-8 e
 * proteção contra injeção de fórmulas (células que começam com = + - @ ou
 * tabulação viram texto).
 */
export type CsvValue = string | number | null | undefined | Date;

function cell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

export const csvMoney = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '' : (cents / 100).toFixed(2).replace('.', ',');

export const csvDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');

export function csvDateTime(d: Date | string | null | undefined, timeZone = 'America/Sao_Paulo') {
  if (!d) return '';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(new Date(d));
}
