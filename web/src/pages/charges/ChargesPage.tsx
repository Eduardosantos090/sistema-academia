import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { Charge, Paged } from '../../api/types';
import {
  Button, ChargeBadge, ConfirmDialog, Empty, ErrorState, Loading, PageHeader, Pagination, SearchInput, Segmented, useToast, usePageTitle,
} from '../../components/ui';
import { Icon } from '../../components/icons';
import { NewChargeModal, PayModal, SendModal, useInvalidateFinance } from '../../components/ChargeModals';
import { fmtCents, fmtDate, fmtDateTime, relDays } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';

const FILTERS = [
  { id: 'abertas', label: 'Em aberto' },
  { id: 'atrasadas', label: 'Em atraso' },
  { id: 'hoje', label: 'Vencem hoje' },
  { id: 'vencendo', label: 'Próximos 7 dias' },
  { id: 'a_conferir', label: 'A conferir' },
  { id: 'pagas', label: 'Pagas' },
  { id: 'canceladas', label: 'Canceladas' },
] as const;
type Filter = (typeof FILTERS)[number]['id'];

export function ChargesPage() {
  usePageTitle('Cobranças');
  const toast = useToast();
  const invalidate = useInvalidateFinance();
  const [params, setParams] = useSearchParams();
  const filter = (FILTERS.find((f) => f.id === params.get('filtro'))?.id ?? 'abertas') as Filter;
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q, 300);
  const [pay, setPay] = useState<Charge | null>(null);
  const [send, setSend] = useState<Charge | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; label: string; action: () => Promise<unknown> }>(null);
  const list = useQuery({
    queryKey: ['charges', filter, dq, page],
    queryFn: () => api.get<Paged<Charge> & { totalCents: number }>(`/api/charges${qs({ filter, q: dq, page, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      invalidate();
      setConfirm(null);
      toast.success('Pronto.');
    },
    onError: (e) => toast.error(e),
  });

  return (
    <div>
      <PageHeader
        title="Cobranças"
        subtitle="Vencimentos gerados pelas assinaturas e cobranças avulsas."
        actions={
          <>
            <a className="btn" href={`/api/charges/export${qs({ filter, q: dq })}`} download>
              <Icon name="file" /> Exportar planilha
            </a>
            <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" /> Cobrança avulsa</Button>
          </>
        }
      />
      <div className="toolbar">
        <Segmented<Filter>
          label="Filtrar cobranças"
          value={filter}
          onChange={(v) => { setParams({ filtro: v }); setPage(1); }}
          options={FILTERS.map((f) => ({ id: f.id, label: f.label }))}
        />
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Cliente ou descrição" label="Buscar cobranças" />
      </div>
      {filter === 'a_conferir' && (
        <p className="muted small" style={{ marginTop: -4 }}>
          Clientes que avisaram pelo assistente que já pagaram. Confira no extrato e registre o pagamento — ou volte a cobrar se não encontrar.
        </p>
      )}
      <div className="card">
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data?.items.length ? (
          <Empty title={filter === 'atrasadas' ? 'Ninguém em atraso! 🎉' : 'Nenhuma cobrança encontrada'} icon="receipt" />
        ) : (
          <>
            <div className="card-header">
              <span className="muted small">{list.data.total} cobrança(s)</span>
              <strong className="num">Total: {fmtCents(list.data.totalCents)}</strong>
            </div>
            <div className="table-wrap">
              <table className="table responsive">
                <thead>
                  <tr><th>Vencimento</th><th>Cliente</th><th>Descrição</th><th className="right">Valor</th><th>Situação</th><th className="actions">Ações</th></tr>
                </thead>
                <tbody>
                  {list.data.items.map((ch) => (
                    <tr key={ch.id}>
                      <td data-label="Vencimento">
                        <div className="num">{fmtDate(ch.dueDate)}</div>
                        {ch.status === 'aberta' && ch.daysLate !== undefined && (
                          <div className={`tiny ${ch.daysLate > 0 ? 'red' : 'muted'}`}>{ch.daysLate > 0 ? `atrasada ${relDays(ch.daysLate)}` : relDays(ch.daysLate)}</div>
                        )}
                      </td>
                      <td data-label="Cliente"><Link to={`/app/clientes/${ch.customerId}`}>{ch.customerName}</Link></td>
                      <td data-label="Descrição">
                        {ch.description}
                        {ch.reportedPaidAt && <div className="tiny" style={{ color: 'var(--info)' }}>Informou pagamento em {fmtDateTime(ch.reportedPaidAt)}</div>}
                        {ch.status === 'paga' && <div className="tiny muted">Pago em {fmtDateTime(ch.paidAt)}</div>}
                      </td>
                      <td data-label="Valor" className="right num">{fmtCents(ch.status === 'paga' ? ch.paidAmountCents ?? ch.amountCents : ch.amountCents)}</td>
                      <td data-label="Situação"><ChargeBadge charge={ch} /></td>
                      <td className="actions">
                        {ch.status === 'aberta' && (
                          <div className="row-sm" style={{ justifyContent: 'flex-end' }}>
                            {ch.reportedPaidAt && (
                              <Button size="sm" variant="ghost" title="Não encontrei o pagamento" onClick={() => setConfirm({
                                title: 'Pagamento não encontrado',
                                message: 'A cobrança volta a receber os lembretes de atraso normalmente.',
                                label: 'Voltar a cobrar',
                                action: () => api.post(`/api/charges/${ch.id}/dismiss-report`),
                              })}>Não encontrei</Button>
                            )}
                            <Button size="sm" variant="ghost" className="btn-icon" title="Enviar lembrete" aria-label={`Enviar lembrete para ${ch.customerName}`} onClick={() => setSend(ch)}>
                              <Icon name="send" size={16} />
                            </Button>
                            <Button size="sm" onClick={() => setPay(ch)}><Icon name="check" size={16} /> Pago</Button>
                          </div>
                        )}
                        {ch.status === 'paga' && (
                          <Button size="sm" variant="ghost" onClick={() => setConfirm({
                            title: 'Estornar pagamento', message: 'A cobrança volta a ficar em aberto.', label: 'Estornar',
                            action: () => api.post(`/api/charges/${ch.id}/unpay`),
                          })}>Estornar</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
      {pay && <PayModal charge={pay} onClose={() => setPay(null)} />}
      {send && <SendModal charge={send} onClose={() => setSend(null)} />}
      {creating && <NewChargeModal onClose={() => setCreating(false)} />}
      {confirm && (
        <ConfirmDialog title={confirm.title} message={confirm.message} confirmLabel={confirm.label} loading={run.isPending}
          onCancel={() => setConfirm(null)} onConfirm={() => run.mutate(confirm.action)} />
      )}
    </div>
  );
}
