import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import { Alert, Button, Checkbox, Empty, ErrorState, Loading, Modal, PageHeader, SearchInput, Segmented, useToast, usePageTitle } from '../../components/ui';
import { Icon, WhatsAppIcon } from '../../components/icons';
import { fmtCents, fmtDate, fmtDateTime, relDays } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';

type Status = 'todos' | 'enviado' | 'faltando' | 'na_fila' | 'falhou';
interface Row {
  id: string; description: string; amountCents: number; dueDate: string; daysLate: number; reportedPaidAt: string | null;
  customerId: string; customerName: string; customerPhone: string | null; customerEmail: string | null;
  whatsappOptIn: boolean; emailOptIn: boolean; sent: number; queued: number; failed: number;
  lastSentAt: string | null; lastChannel: string | null; channels: string | null; reminderStatus: Exclude<Status, 'todos'>;
}
interface Counts { total: number; enviado: number; faltando: number; na_fila: number; falhou: number }

const BADGE: Record<Row['reminderStatus'], [string, string]> = {
  enviado: ['Enviado', 'badge-success'],
  faltando: ['Falta enviar', 'badge-danger'],
  na_fila: ['Na fila', 'badge-info'],
  falhou: ['Falhou', 'badge-warning'],
};

export function RemindersPage() {
  usePageTitle('Controle de envios');
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const [days, setDays] = useState(['1', '2', '3', '7', '15', '30'].includes(params.get('periodo') ?? '') ? params.get('periodo')! : '7');
  const [status, setStatus] = useState<Status>('todos');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<null | { ids?: string[]; allMissing?: boolean }>(null);
  const list = useQuery({
    queryKey: ['reminders', days, status, dq],
    queryFn: () => api.get<{ items: Row[]; counts: Counts }>(`/api/reminders${qs({ days, status, q: dq })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const items = list.data?.items ?? [];
  const c = list.data?.counts;
  const allChecked = items.length > 0 && items.every((i) => selected.has(i.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const progress = c && c.total ? Math.round((c.enviado / c.total) * 100) : 0;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader
        title="Controle de envios"
        subtitle="Quem já recebeu o lembrete e quem ainda falta — cobranças em atraso e que vencem nos próximos dias."
        actions={
          <Button variant="primary" disabled={!c?.faltando} onClick={() => setSending({ allMissing: true })}>
            <Icon name="send" /> Enviar para quem falta ({c?.faltando ?? 0})
          </Button>
        }
      />
      {c && (
        <div className="grid grid-4">
          <div className="card stat"><div className="stat-icon"><Icon name="checkCircle" /></div><div className="label">Já receberam</div><div className="value">{c.enviado}</div>
            <div className="progress" style={{ marginTop: 8 }} aria-label={`${progress}% enviados`}><span style={{ width: `${progress}%` }} /></div></div>
          <div className="card stat danger"><div className="stat-icon"><Icon name="alert" /></div><div className="label">Faltam receber</div><div className="value">{c.faltando}</div></div>
          <div className="card stat info"><div className="stat-icon"><Icon name="clock" /></div><div className="label">Na fila / envio manual</div><div className="value">{c.na_fila}</div></div>
          <div className="card stat warning"><div className="stat-icon"><Icon name="refresh" /></div><div className="label">Com falha</div><div className="value">{c.falhou}</div></div>
        </div>
      )}
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <Segmented label="Período" value={days} onChange={(v) => { setDays(v); setSelected(new Set()); }}
          options={[{ id: '1', label: 'Até amanhã' }, { id: '2', label: '2 dias' }, { id: '3', label: '3 dias' }, { id: '7', label: '7 dias' }, { id: '15', label: '15 dias' }, { id: '30', label: '30 dias' }]} />
        <Segmented<Status> label="Situação" value={status} onChange={(v) => { setStatus(v); setSelected(new Set()); }}
          options={[{ id: 'todos', label: 'Todos' }, { id: 'faltando', label: 'Faltam', count: c?.faltando }, { id: 'enviado', label: 'Enviados', count: c?.enviado }, { id: 'na_fila', label: 'Na fila', count: c?.na_fila }, { id: 'falhou', label: 'Falhou', count: c?.falhou }]} />
        <SearchInput value={q} onChange={setQ} placeholder="Buscar cliente" label="Buscar cliente" />
      </div>
      <p className="muted small" style={{ margin: 0 }}>Inclui as cobranças em atraso e as que vencem dentro do período escolhido.</p>
      <div className="card">
        {selected.size > 0 && (
          <div className="card-header">
            <strong>{selected.size} selecionada(s)</strong>
            <div className="row-sm">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar</Button>
              <Button size="sm" variant="primary" onClick={() => setSending({ ids: [...selected] })}><Icon name="send" size={14} /> Enviar lembrete</Button>
            </div>
          </div>
        )}
        {list.isLoading ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !items.length ? (
          <Empty title={status === 'faltando' ? 'Ninguém faltando! 🎉' : 'Nenhuma cobrança no período'} icon="calendarCheck" />
        ) : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead>
                <tr>
                  <th style={{ width: 36 }}><input type="checkbox" aria-label="Selecionar todos" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(items.map((i) => i.id)))} /></th>
                  <th>Cliente</th><th>Vencimento</th><th className="right">Valor</th><th>Lembrete</th><th>Último envio</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td><input type="checkbox" aria-label={`Selecionar ${r.customerName}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                    <td data-label="Cliente">
                      <Link to={`/app/clientes/${r.customerId}`}>{r.customerName}</Link>
                      <div className="tiny muted">{r.description}</div>
                    </td>
                    <td data-label="Vencimento">
                      <div className="num">{fmtDate(r.dueDate)}</div>
                      <div className={`tiny ${r.daysLate > 0 ? 'red' : 'muted'}`}>{r.daysLate > 0 ? `atrasada ${relDays(r.daysLate)}` : relDays(r.daysLate)}</div>
                    </td>
                    <td data-label="Valor" className="right num">{fmtCents(r.amountCents)}</td>
                    <td data-label="Lembrete">
                      <span className={`badge ${BADGE[r.reminderStatus][1]}`}>{BADGE[r.reminderStatus][0]}</span>
                      {r.sent > 1 && <span className="tiny muted"> · {r.sent} envios</span>}
                      {!r.whatsappOptIn && <div className="tiny yellow">não recebe WhatsApp</div>}
                    </td>
                    <td data-label="Último envio" className="small">
                      {r.lastSentAt ? (
                        <span className="row-sm">
                          {r.lastChannel === 'whatsapp' ? <span style={{ color: 'var(--whatsapp)' }}><WhatsAppIcon size={14} /></span> : <Icon name="mail" size={14} />}
                          {fmtDateTime(r.lastSentAt)}
                        </span>
                      ) : <span className="faint">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {sending && (
        <BulkSendModal
          days={days}
          target={sending}
          count={sending.ids?.length ?? c?.faltando ?? 0}
          onClose={() => setSending(null)}
          onDone={(msg) => {
            setSending(null);
            setSelected(new Set());
            toast.success(msg);
            for (const k of ['reminders', 'messages', 'counters', 'dashboard']) void qc.invalidateQueries({ queryKey: [k] });
          }}
        />
      )}
    </div>
  );
}

function BulkSendModal({ days, target, count, onClose, onDone }: {
  days: string; target: { ids?: string[]; allMissing?: boolean }; count: number; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [wa, setWa] = useState(true);
  const [email, setEmail] = useState(false);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ organization: { sendDelaySeconds: number }; channels: { whatsappAutomatic: boolean } }>('/api/settings') });
  const delay = settings.data?.organization.sendDelaySeconds ?? 0;
  const estimate = useMemo(() => {
    const total = delay * Math.max(0, count - 1);
    return total >= 3600 ? `${Math.round(total / 360) / 10} h` : total >= 60 ? `${Math.round(total / 60)} min` : `${total} s`;
  }, [delay, count]);
  const m = useMutation({
    mutationFn: () => api.post<{ queued: number; manual: number; skipped: number; errors: string[] }>('/api/reminders/send', {
      chargeIds: target.ids, allMissing: !!target.allMissing, days: Number(days), whatsapp: wa, email,
    }),
    onSuccess: (r) =>
      onDone(
        [r.queued && `${r.queued} na fila de envio`, r.manual && `${r.manual} prontos para envio manual (Mensagens)`, r.skipped && `${r.skipped} ignorado(s)`]
          .filter(Boolean)
          .join(' · ') || 'Nada a enviar.',
      ),
  });
  return (
    <Modal title={`Enviar lembrete para ${count} cobrança(s)`} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} disabled={!wa && !email} onClick={() => m.mutate()}><Icon name="send" /> Enviar</Button>
      </>
    }>
      <div className="stack">
        {m.error && <Alert>{(m.error as Error).message}</Alert>}
        <div className="row">
          <Checkbox checked={wa} onChange={(e) => setWa(e.target.checked)} label="WhatsApp" />
          <Checkbox checked={email} onChange={(e) => setEmail(e.target.checked)} label="E-mail" />
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          O modelo é escolhido pela situação de cada cobrança (lembrete, vencimento ou atraso). Clientes que pediram para não
          receber são ignorados, e quem já tem mensagem na fila não recebe em dobro.
        </p>
        {settings.data && !settings.data.channels.whatsappAutomatic && wa && (
          <Alert kind="info">WhatsApp em modo manual: as mensagens ficam prontas em <strong>Mensagens</strong> para envio com um clique.</Alert>
        )}
        {delay > 0 && settings.data?.channels.whatsappAutomatic && (
          <Alert kind="info">Intervalo de {delay >= 60 && delay % 60 === 0 ? `${delay / 60} min` : `${delay} s`} entre mensagens: o envio completo leva cerca de {estimate}.</Alert>
        )}
      </div>
    </Modal>
  );
}
