import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, qs } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Empty, Loading, PageHeader, usePageTitle } from '../components/ui';
import { fmtDateTime } from '../lib/format';

interface Ev { id: number; action: string; entityType: string | null; entityId: string | null; details: Record<string, unknown>; ip: string | null; createdAt: string; actorName: string | null; organizationName: string | null }

const LABELS: Record<string, string> = {
  'auth.login': 'Entrou no sistema', 'auth.logout': 'Saiu', 'auth.login_failed': 'Tentativa de acesso com senha errada',
  'auth.password_changed': 'Trocou a senha', 'auth.password_reset': 'Redefiniu a senha', 'auth.invite_accepted': 'Aceitou o convite',
  'customer.created': 'Cadastrou cliente', 'customer.updated': 'Alterou cliente', 'customer.deleted': 'Excluiu dados de cliente (LGPD)',
  'charge.created': 'Criou cobrança', 'charge.paid': 'Registrou pagamento', 'charge.unpaid': 'Estornou pagamento', 'charge.cancelled': 'Cancelou cobrança',
  'subscription.created': 'Criou assinatura', 'subscription.updated': 'Alterou assinatura', 'message.created': 'Enviou mensagem',
  'settings.whatsapp': 'Alterou integração do WhatsApp', 'settings.organization': 'Alterou configurações', 'team.user_created': 'Convidou usuário',
  'team.user_updated': 'Alterou usuário', 'platform.org_created': 'Criou organização', 'platform.org_suspended': 'Suspendeu organização',
};

export function AuditPage() {
  usePageTitle('Auditoria');
  const { isPlatform, hasOrg } = useAuth();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['audit', page],
    queryFn: () => api.get<{ items: Ev[]; pageSize: number }>(`/api/audit${qs({ page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <div>
      <PageHeader title="Auditoria" subtitle={isPlatform && !hasOrg ? 'Registro de todas as operações da plataforma.' : 'Quem fez o quê na sua conta.'} />
      <div className="card">
        {q.isLoading ? <Loading /> : !q.data?.items.length ? <Empty title="Nenhum evento" icon="shield" /> : (
          <>
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Quando</th><th>Quem</th><th>O quê</th>{isPlatform && <th>Organização</th>}<th>IP</th></tr></thead>
                <tbody>
                  {q.data.items.map((e) => (
                    <tr key={e.id}>
                      <td data-label="Quando" className="small nowrap">{fmtDateTime(e.createdAt)}</td>
                      <td data-label="Quem">{e.actorName ?? <span className="faint">sistema</span>}</td>
                      <td data-label="O quê">{LABELS[e.action] ?? e.action}</td>
                      {isPlatform && <td data-label="Organização" className="small">{e.organizationName ?? '—'}</td>}
                      <td data-label="IP" className="small mono">{e.ip ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Mais recentes</Button>
              <span className="small muted">Página {page}</span>
              <Button size="sm" disabled={q.data.items.length < q.data.pageSize} onClick={() => setPage(page + 1)}>Mais antigos</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
