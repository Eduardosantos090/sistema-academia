import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { Message, MessageStatus, Paged } from '../../api/types';
import { Button, Empty, ErrorState, Loading, MessageBadge, PageHeader, Pagination, Segmented, WhatsAppLink, useToast, usePageTitle } from '../../components/ui';
import { Icon, WhatsAppIcon } from '../../components/icons';
import { fmtDateTime, fmtPhone } from '../../lib/format';

type F = 'todas' | MessageStatus;
interface Counts { manual: number; pendente: number; falhou: number; enviadas30d: number }

export function MessagesPage() {
  usePageTitle('Mensagens');
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as F) || 'todas';
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['messages', status, page],
    queryFn: () => api.get<Paged<Message> & { counts: Counts }>(`/api/messages${qs({ status: status === 'todas' ? undefined : status, page, pageSize: 30 })}`),
    placeholderData: keepPreviousData,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['counters'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'mark-sent' | 'cancel' | 'retry' }) =>
      api.post<{ status?: string; error?: string | null; waLink?: string | null }>(`/api/messages/${id}/${action}`),
    onSuccess: (r, v) => {
      refresh();
      if (v.action === 'retry') {
        if (r.waLink) window.open(r.waLink, '_blank', 'noopener,noreferrer');
        else if (r.status === 'enviada') toast.success('Mensagem reenviada.');
        else toast.error(r.error ?? 'Ainda não foi possível enviar.');
      }
    },
    onError: (e) => toast.error(e),
  });
  const c = list.data?.counts;

  return (
    <div>
      <PageHeader
        title="Mensagens"
        subtitle="Tudo o que o Venceu enviou ou vai enviar aos seus clientes."
      />
      <div className="toolbar">
        <Segmented<F>
          label="Situação"
          value={status}
          onChange={(v) => { setParams(v === 'todas' ? {} : { status: v }); setPage(1); }}
          options={[
            { id: 'todas', label: 'Todas' },
            { id: 'manual', label: 'Para enviar no WhatsApp', count: c?.manual },
            { id: 'pendente', label: 'Na fila', count: c?.pendente },
            { id: 'enviada', label: 'Enviadas' },
            { id: 'falhou', label: 'Com falha', count: c?.falhou },
            { id: 'cancelada', label: 'Canceladas' },
          ]}
        />
      </div>
      {status === 'manual' && (
        <p className="muted small">
          O WhatsApp automático não está configurado, então os lembretes ficam prontos aqui: toque em <strong>Enviar no WhatsApp</strong>,
          envie a mensagem e ela é marcada como enviada. Configure o envio automático em Configurações → WhatsApp.
        </p>
      )}
      <div className="card">
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data?.items.length ? (
          <Empty title={status === 'manual' ? 'Nenhum envio manual pendente' : 'Nenhuma mensagem'} icon="send" />
        ) : (
          <>
            <ul className="list">
              {list.data.items.map((m) => (
                <li key={m.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <span style={{ color: m.channel === 'whatsapp' ? 'var(--whatsapp)' : 'var(--info)', marginTop: 2 }}>
                    {m.channel === 'whatsapp' ? <WhatsAppIcon size={20} /> : <Icon name="mail" size={20} />}
                  </span>
                  <div className="grow">
                    <div className="row-sm">
                      {m.customerId ? <Link to={`/app/clientes/${m.customerId}`} style={{ fontWeight: 650, color: 'var(--text)', textDecoration: 'none' }}>{m.customerName}</Link> : <strong>—</strong>}
                      <span className="muted small">{m.channel === 'whatsapp' ? fmtPhone(m.toAddress) : m.toAddress}</span>
                      <MessageBadge status={m.status} />
                      <span className="badge plain">{m.kind}</span>
                      <span className="tiny muted">{fmtDateTime(m.sentAt ?? m.createdAt)}</span>
                    </div>
                    {m.subject && <div className="small" style={{ marginTop: 6, fontWeight: 600 }}>{m.subject}</div>}
                    <div className="small pre-wrap muted" style={{ marginTop: 4 }}>{m.body}</div>
                    {m.error && <div className="tiny red" style={{ marginTop: 4 }}>{m.error}</div>}
                  </div>
                  <div className="row-sm" style={{ justifyContent: 'flex-end' }}>
                    {m.status === 'manual' && m.waLink && (
                      <WhatsAppLink size="sm" href={m.waLink} onOpened={() => act.mutate({ id: m.id, action: 'mark-sent' })}>
                        <WhatsAppIcon size={15} /> Enviar no WhatsApp
                      </WhatsAppLink>
                    )}
                    {m.status === 'falhou' && <Button size="sm" onClick={() => act.mutate({ id: m.id, action: 'retry' })}><Icon name="refresh" size={14} /> Tentar de novo</Button>}
                    {['manual', 'pendente', 'falhou'].includes(m.status) && (
                      <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: m.id, action: 'cancel' })}>Descartar</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
