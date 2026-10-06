import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { InviteResult } from '../../api/types';
import { Alert, Button, ConfirmDialog, Empty, Loading, PageHeader, SecretLink, Segmented, useToast, usePageTitle } from '../../components/ui';
import { fmtDateTime, fmtPhone, segmentLabel } from '../../lib/format';

interface Req {
  id: string; name: string; businessName: string; segment: string; email: string; phone: string | null; message: string | null;
  status: 'novo' | 'aprovado' | 'recusado'; createdAt: string; decidedAt: string | null;
}

export function RequestsPage() {
  usePageTitle('Pedidos de acesso');
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<Req['status']>('novo');
  const [result, setResult] = useState<InviteResult | null>(null);
  const [rejecting, setRejecting] = useState<Req | null>(null);
  const list = useQuery({ queryKey: ['requests', status], queryFn: () => api.get<{ items: Req[] }>(`/api/platform/requests?status=${status}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['requests'] });
    void qc.invalidateQueries({ queryKey: ['orgs'] });
    void qc.invalidateQueries({ queryKey: ['platform-overview'] });
  };
  const approve = useMutation({
    mutationFn: (id: string) => api.post<InviteResult>(`/api/platform/requests/${id}/approve`, {}),
    onSuccess: (r) => {
      setResult(r);
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.post(`/api/platform/requests/${id}/reject`),
    onSuccess: () => {
      setRejecting(null);
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="stack">
      <PageHeader title="Pedidos de acesso" subtitle="Empresas que pediram para usar o Venceu pelo site." />
      <Segmented label="Situação" value={status} onChange={setStatus} options={[{ id: 'novo', label: 'Novos' }, { id: 'aprovado', label: 'Aprovados' }, { id: 'recusado', label: 'Recusados' }]} />
      {result?.inviteLink && <div className="card card-body"><SecretLink link={result.inviteLink} hours={result.validHours} /></div>}
      {result?.inviteSent && <Alert kind="success">Organização criada e convite enviado por e-mail.</Alert>}
      <div className="card">
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty title="Nenhum pedido" icon="inbox" /> : (
          <ul className="list">
            {list.data.items.map((r) => (
              <li key={r.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <span className="title">{r.businessName} <span className="muted small">· {segmentLabel[r.segment] ?? r.segment}</span></span>
                  <span className="sub">{r.name} · {r.email} · {fmtPhone(r.phone)} · {fmtDateTime(r.createdAt)}</span>
                  {r.message && <div className="small pre-wrap" style={{ marginTop: 6 }}>{r.message}</div>}
                </div>
                {r.status === 'novo' && (
                  <div className="row-sm">
                    <Button size="sm" variant="primary" loading={approve.isPending && approve.variables === r.id} onClick={() => approve.mutate(r.id)}>Aprovar e criar</Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(r)}>Recusar</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {rejecting && (
        <ConfirmDialog title="Recusar pedido" message={`Recusar o pedido de ${rejecting.businessName}?`} danger confirmLabel="Recusar"
          loading={reject.isPending} onCancel={() => setRejecting(null)} onConfirm={() => reject.mutate(rejecting.id)} />
      )}
    </div>
  );
}
