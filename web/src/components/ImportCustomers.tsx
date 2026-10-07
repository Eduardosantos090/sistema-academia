import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { Alert, Button, Modal } from './ui';
import { Icon } from './icons';
import { fmtCents, fmtDate, parseMoneyToCents, todayIso } from '../lib/format';

/**
 * Importação de clientes por planilha CSV (Excel: "Salvar como → CSV").
 * Lido no navegador: detecta separador (; ou ,), acentuação (UTF-8 ou
 * Windows-1252, padrão do Excel no Brasil) e reconhece os nomes de colunas
 * mais comuns. O servidor valida cada linha novamente.
 */

type Field = 'name' | 'phone' | 'email' | 'document' | 'planName' | 'amountCents' | 'intervalMonths' | 'firstDueDate' | 'notes';

const ALIASES: Record<Field, string[]> = {
  name: ['nome', 'nome completo', 'cliente', 'aluno', 'name'],
  phone: ['telefone', 'whatsapp', 'celular', 'fone', 'tel', 'phone', 'contato'],
  email: ['email', 'e-mail', 'e mail', 'mail'],
  document: ['cpf', 'cnpj', 'cpf/cnpj', 'documento'],
  planName: ['plano', 'produto', 'servico', 'serviço', 'modalidade', 'descricao', 'descrição'],
  amountCents: ['valor', 'mensalidade', 'preco', 'preço', 'valor mensal'],
  intervalMonths: ['periodicidade', 'frequencia', 'frequência', 'recorrencia', 'recorrência', 'ciclo'],
  firstDueDate: ['vencimento', 'proximo vencimento', 'próximo vencimento', 'dia de vencimento', 'data de vencimento', 'dia vencimento', 'vence'],
  notes: ['observacao', 'observação', 'observacoes', 'observações', 'obs', 'notas'],
};

const LABELS: Record<Field, string> = {
  name: 'Nome', phone: 'WhatsApp', email: 'E-mail', document: 'CPF/CNPJ', planName: 'Plano', amountCents: 'Valor',
  intervalMonths: 'Periodicidade', firstDueDate: 'Vencimento', notes: 'Observações',
};

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

function decode(buf: ArrayBuffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** CSV com aspas, separador detectado automaticamente. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) >= (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function toInterval(v: string): number | null {
  const n = norm(v);
  if (!n) return null;
  if (/^\d+$/.test(n)) return [1, 2, 3, 6, 12].includes(Number(n)) ? Number(n) : null;
  if (n.startsWith('mens')) return 1;
  if (n.startsWith('bim')) return 2;
  if (n.startsWith('tri')) return 3;
  if (n.startsWith('sem')) return 6;
  if (n.startsWith('anu') || n.startsWith('ano')) return 12;
  return null;
}

/** "10/11/2026", "2026-11-10", "10/11" ou só o dia "10" (próxima ocorrência). */
function toDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const today = todayIso();
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(today.slice(0, 4));
    const iso = (yy: number) => `${yy}-${m![2]!.padStart(2, '0')}-${m![1]!.padStart(2, '0')}`;
    if (!m[3] && iso(y) < today) y++;
    return iso(y);
  }
  m = s.match(/^(\d{1,2})$/);
  if (m) {
    const day = Number(m[1]);
    if (day < 1 || day > 31) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Próximo mês (a partir de hoje) que tem esse dia.
    for (let k = 0; k < 3; k++) {
      const d = new Date(now.getFullYear(), now.getMonth() + k, day);
      if (d.getDate() === day && d >= today) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
    return null;
  }
  return null;
}

type Row = Partial<Record<Field, string | number | null>> & { name: string };

function mapRows(table: string[][]) {
  const header = table[0]!.map(norm);
  const cols: Partial<Record<Field, number>> = {};
  for (const [field, aliases] of Object.entries(ALIASES) as [Field, string[]][]) {
    const idx = header.findIndex((h) => aliases.map(norm).includes(h));
    if (idx >= 0) cols[field] = idx;
  }
  const get = (r: string[], f: Field) => (cols[f] !== undefined ? (r[cols[f]!] ?? '').trim() : '');
  const rows: Row[] = table.slice(1).map((r) => {
    const amount = get(r, 'amountCents');
    return {
      name: get(r, 'name'),
      phone: get(r, 'phone') || null,
      email: get(r, 'email') || null,
      document: get(r, 'document') || null,
      planName: get(r, 'planName') || null,
      amountCents: amount ? parseMoneyToCents(amount) : null,
      intervalMonths: toInterval(get(r, 'intervalMonths')),
      firstDueDate: toDate(get(r, 'firstDueDate')),
      notes: get(r, 'notes') || null,
    };
  });
  return { cols, rows };
}

const TEMPLATE =
  'Nome;WhatsApp;E-mail;CPF;Plano;Valor;Periodicidade;Vencimento\n' +
  'Maria Oliveira;(11) 98888-7777;maria@email.com;;Plano Mensal;129,90;Mensal;10\n' +
  'João Souza;(11) 97777-6666;;;Plano Trimestral;349,90;Trimestral;15/11/2026\n';

function downloadTemplate() {
  const blob = new Blob(['﻿' + TEMPLATE], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'modelo-clientes-venceu.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

interface Result { created: number; subscriptions: number; duplicates: number; errors: { line: number; message: string }[] }

export function ImportCustomersModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ReturnType<typeof mapRows> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  const read = async (file?: File) => {
    if (!file) return;
    setError(null);
    setResult(null);
    if (file.size > 3 * 1024 * 1024) return setError('Arquivo grande demais (máx. 3 MB).');
    if (/\.xlsx?$/i.test(file.name)) return setError('Salve a planilha como CSV (no Excel: Arquivo → Salvar como → CSV) e envie de novo.');
    const table = parseCsv(decode(await file.arrayBuffer()));
    if (table.length < 2) return setError('A planilha está vazia ou só tem o cabeçalho.');
    const m = mapRows(table);
    if (m.cols.name === undefined) return setError('Não encontrei a coluna "Nome". Use o modelo para conferir os nomes das colunas.');
    if (m.rows.length > 2000) return setError('Máximo de 2.000 clientes por importação. Divida a planilha.');
    setFileName(file.name);
    setParsed(m);
  };

  const run = async () => {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    const total: Result = { created: 0, subscriptions: 0, duplicates: 0, errors: [] };
    try {
      for (let i = 0; i < parsed.rows.length; i += 500) {
        const chunk = parsed.rows.slice(i, i + 500);
        const r = await api.post<Result>('/api/customers/import', { rows: chunk });
        total.created += r.created;
        total.subscriptions += r.subscriptions;
        total.duplicates += r.duplicates;
        total.errors.push(...r.errors.map((e) => ({ ...e, line: e.line + i })));
        setProgress(Math.min(parsed.rows.length, i + 500));
      }
      setResult(total);
      for (const k of ['customers', 'dashboard', 'charges', 'subscriptions', 'reminders']) void qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Falha na importação.');
      if (total.created) setResult(total);
    } finally {
      setBusy(false);
    }
  };

  const found = parsed ? (Object.keys(parsed.cols) as Field[]) : [];
  return (
    <Modal size="lg" title="Importar clientes de planilha" onClose={onClose} footer={
      result ? <Button variant="primary" onClick={onClose}>Concluir</Button> : (
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={busy} disabled={!parsed} onClick={() => void run()}>
            <Icon name="plus" /> Importar {parsed ? parsed.rows.length : ''} cliente(s)
          </Button>
        </>
      )
    }>
      <div className="stack">
        {error && <Alert>{error}</Alert>}
        {result ? (
          <div className="stack">
            <Alert kind="success">
              {result.created} cliente(s) importado(s){result.subscriptions ? `, ${result.subscriptions} com assinatura (cobranças geradas)` : ''}.
              {result.duplicates ? ` ${result.duplicates} já existiam e foram ignorados.` : ''}
            </Alert>
            {result.errors.length > 0 && (
              <div className="stack-sm">
                <strong>{result.errors.length} linha(s) com problema — corrija e importe só essas linhas:</strong>
                <ul className="code-box small" style={{ margin: 0, paddingLeft: 24, maxHeight: 220, overflowY: 'auto' }}>
                  {result.errors.map((e) => <li key={e.line}>Linha {e.line}: {e.message}</li>)}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="code-box stack-sm">
              <span className="small">
                Envie um arquivo <strong>CSV</strong> (no Excel ou Google Planilhas: <em>Arquivo → Salvar como / Fazer download → CSV</em>).
                Colunas reconhecidas: Nome (obrigatória), WhatsApp, E-mail, CPF, Plano, Valor, Periodicidade e Vencimento.
              </span>
              <span className="tiny muted">
                Com <strong>Vencimento</strong> e <strong>Plano</strong> (nome de um plano cadastrado) ou <strong>Valor</strong>, a assinatura é criada e as
                cobranças são geradas. Vencimento aceita data (10/11/2026) ou só o dia do mês (10). Quem já está cadastrado (mesmo WhatsApp ou e-mail) é ignorado.
              </span>
              <div className="row-sm">
                <Button size="sm" onClick={downloadTemplate}><Icon name="file" size={14} /> Baixar modelo</Button>
                <input ref={input} type="file" accept=".csv,text/csv,.xlsx,.xls" hidden onChange={(e) => void read(e.target.files?.[0])} />
                <Button size="sm" variant="primary" onClick={() => input.current?.click()}><Icon name="plus" size={14} /> Escolher planilha</Button>
                {fileName && <span className="small muted">{fileName}</span>}
              </div>
            </div>
            {parsed && (
              <div className="stack-sm">
                <span className="small">
                  <strong>{parsed.rows.length}</strong> linha(s). Colunas encontradas: {found.map((f) => LABELS[f]).join(', ')}.
                </span>
                <div className="table-wrap card">
                  <table className="table">
                    <thead><tr><th>Nome</th><th>WhatsApp</th><th>E-mail</th><th>Plano</th><th className="right">Valor</th><th>Vencimento</th></tr></thead>
                    <tbody>
                      {parsed.rows.slice(0, 8).map((r, i) => (
                        <tr key={i}>
                          <td>{r.name || <span className="red">(vazio)</span>}</td>
                          <td className="small">{r.phone ?? '—'}</td>
                          <td className="small">{r.email ?? '—'}</td>
                          <td className="small">{r.planName ?? '—'}</td>
                          <td className="right small num">{typeof r.amountCents === 'number' ? fmtCents(r.amountCents) : '—'}</td>
                          <td className="small num">{typeof r.firstDueDate === 'string' ? fmtDate(r.firstDueDate) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {parsed.rows.length > 8 && <span className="tiny muted">…e mais {parsed.rows.length - 8}.</span>}
                {busy && <div className="progress"><span style={{ width: `${Math.round((progress / parsed.rows.length) * 100)}%` }} /></div>}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
