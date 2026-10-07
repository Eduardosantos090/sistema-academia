import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../../api/client';
import type { InviteResult } from '../../api/types';
import { Alert, Button, Empty, Loading, Modal, PageHeader, SearchInput, SecretLink, SelectField, TextField, fieldErrors, useToast, usePageTitle } from '../../components/ui';
import { Icon } from '../../components/icons';
import { fmtCents, fmtDate, fmtDateTime, segmentLabel } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';

interface Org {
  id: string; name: string; slug: string; segment: string; contactEmail: string | null; isActive: boolean; createdAt: string;
  customers: number; users: number; messages30d: number; lastLoginAt: string | null; whatsappMode: string | null;
  planName: string | null; planAmountCents: number | null; accessUntil: string | null; accessDaysLeft: number | null;
  autoSuspend: boolean; autoBilling: boolean; suspendedReason: string | null; isBillingOrg: boolean;
}

export function AccessBadge({ o }: { o: Pick<Org, 'isActive' | 'accessUntil' | 'accessDaysLeft' | 'suspendedReason' | 'isBillingOrg'> }) {
  if (o.isBillingOrg) return <span className="badge badge-info">Cobrança da plataforma</span>;
  if (!o.isActive) return <span className="badge badge-danger">{o.suspendedReason === 'inadimplencia' ? 'Suspensa (atraso)' : 'Desativada'}</span>;
  if (o.accessDaysLeft === null) return <span className="badge badge-success">Ativa</span>;
  if (o.accessDaysLeft < 0) return <span className="badge badge-danger">Vencida há {-o.accessDaysLeft}d</span>;
  if (o.accessDaysLeft <= 5) return <span className="badge badge-warning">Vence em {o.accessDaysLeft}d</span>;
  return <span className="badge badge-success">Ativa</span>;
}
interface Overview { activeOrgs: number; totalOrgs: number; customers: number; messages30d: number; pendingRequests: number }

export function OrgsPage() {
  usePageTitle('Organizações');
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<InviteResult | null>(null);
  const ov = useQuery({ queryKey: ['platform-overview'], queryFn: () => api.get<Overview>('/api/platform/overview') });
  const list = useQuery({ queryKey: ['orgs', dq], queryFn: () => api.get<{ items: Org[] }>(`/api/platform/orgs${qs({ q: dq })}`) });
  const qc = useQueryClient();
  const toast = useToast();
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.patch(`/api/platform/orgs/${id}`, { isActive }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['orgs'] });
      toast.success(v.isActive ? 'Acesso ativado.' : 'Acesso desativado. Os usuários foram desconectados.');
    },
    onError: (e) => toast.error(e),
  });
  const billing = useQuery({ queryKey: ['billing-org'], queryFn: () => api.get<{ org: { id: string; name: string } | null }>('/api/platform/billing-org') });
  const setBilling = useMutation({
    mutationFn: (orgId: string | null) => api.put('/api/platform/billing-org', { orgId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing-org'] });
      void qc.invalidateQueries({ queryKey: ['orgs'] });
      toast.success('Organização de cobrança definida.');
    },
    onError: (e) => toast.error(e),
  });
  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader
        title="Organizações"
        subtitle="Empresas que usam o Venceu. A plataforma vê apenas cadastro e totais — nunca os dados dos clientes delas."
        actions={<Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" /> Nova organização</Button>}
      />
      {ov.data && (
        <div className="grid grid-4">
          <div className="card stat"><div className="stat-icon"><Icon name="building" /></div><div className="label">Organizações ativas</div><div className="value">{ov.data.activeOrgs}</div><div className="meta">{ov.data.totalOrgs} no total</div></div>
          <div className="card stat info"><div className="stat-icon"><Icon name="users" /></div><div className="label">Clientes atendidos</div><div className="value">{ov.data.customers}</div></div>
          <div className="card stat"><div className="stat-icon"><Icon name="send" /></div><div className="label">Mensagens em 30 dias</div><div className="value">{ov.data.messages30d}</div></div>
          <Link to="/app/plataforma/pedidos" className="card stat warning" style={{ textDecoration: 'none', color: 'inherit' }}><div className="stat-icon"><Icon name="inbox" /></div><div className="label">Pedidos de acesso</div><div className="value">{ov.data.pendingRequests}</div><div className="meta">aguardando análise</div></Link>
        </div>
      )}
      {created?.inviteLink && <div className="card card-body"><SecretLink link={created.inviteLink} hours={created.validHours} /></div>}
      {created?.inviteSent && <Alert kind="success">Organização criada e convite enviado por e-mail ao responsável.</Alert>}
      <section className="card card-body row" style={{ alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <SelectField
            label="Organização de cobrança da plataforma"
            hint="Sua empresa dentro do Venceu: é por ela que os planos dos clientes são cobrados automaticamente (lembretes, PIX, baixa)."
            value={billing.data?.org?.id ?? ''}
            onChange={(e) => setBilling.mutate(e.target.value || null)}
          >
            <option value="">— não definida —</option>
            {list.data?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </SelectField>
        </div>
      </section>
      <div className="toolbar"><SearchInput value={q} onChange={setQ} placeholder="Buscar organização" label="Buscar organização" /></div>
      <div className="card">
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty title="Nenhuma organização" icon="building" /> : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead><tr><th>Organização</th><th>Plano</th><th>Acesso até</th><th className="right">Clientes</th><th className="right">Msgs 30d</th><th>Último acesso</th><th>Situação</th><th className="actions">Acesso</th></tr></thead>
              <tbody>
                {list.data.items.map((o) => (
                  <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/app/plataforma/organizacoes/${o.id}`)}>
                    <td data-label="Organização"><Link to={`/app/plataforma/organizacoes/${o.id}`}>{o.name}</Link><div className="tiny muted">{o.contactEmail}</div></td>
                    <td data-label="Plano">
                      {o.planName ?? <span className="faint">—</span>}
                      {o.planAmountCents ? <div className="tiny muted">{fmtCents(o.planAmountCents)}{o.autoBilling ? ' · cobrança automática' : ''}</div> : null}
                    </td>
                    <td data-label="Acesso até" className="num small">{o.accessUntil ? fmtDate(o.accessUntil) : <span className="faint">sem limite</span>}</td>
                    <td data-label="Clientes" className="right num">{o.customers}</td>
                    <td data-label="Msgs 30d" className="right num">{o.messages30d}</td>
                    <td data-label="Último acesso" className="small">{fmtDateTime(o.lastLoginAt)}</td>
                    <td data-label="Situação"><AccessBadge o={o} /></td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      {!o.isBillingOrg && (o.isActive
                        ? <Button size="sm" variant="danger" onClick={() => toggle.mutate({ id: o.id, isActive: false })}>Desativar</Button>
                        : <Button size="sm" variant="primary" onClick={() => toggle.mutate({ id: o.id, isActive: true })}>Ativar</Button>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <NewOrgModal onClose={() => setCreating(false)} onCreated={setCreated} />}
    </div>
  );
}

function NewOrgModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: InviteResult) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', segment: 'academia', contactPhone: '', ownerName: '', ownerEmail: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => api.post<InviteResult>('/api/platform/orgs', { ...f, contactPhone: f.contactPhone || null }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['orgs'] });
      void qc.invalidateQueries({ queryKey: ['platform-overview'] });
      onCreated(r);
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof ApiError ? e.message : 'Não foi possível criar.');
    },
  });
  return (
    <Modal title="Nova organização" onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} disabled={!f.name || !f.ownerName || !f.ownerEmail} onClick={() => m.mutate()}>Criar e convidar responsável</Button>
      </>
    }>
      <div className="stack">
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <TextField label="Nome da empresa" value={f.name} onChange={set('name')} error={errors.name} />
          <SelectField label="Segmento" value={f.segment} onChange={set('segment')}>
            {Object.entries(segmentLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
          <TextField label="Responsável" value={f.ownerName} onChange={set('ownerName')} error={errors.ownerName} />
          <TextField label="E-mail do responsável" type="email" value={f.ownerEmail} onChange={set('ownerEmail')} error={errors.ownerEmail} />
          <TextField label="Telefone (opcional)" value={f.contactPhone} onChange={set('contactPhone')} error={errors.contactPhone} />
        </div>
        <p className="muted small" style={{ margin: 0 }}>A organização já nasce com modelos de mensagem, regras de lembrete (D-3, D, D+3, D+10) e o assistente configurado.</p>
      </div>
    </Modal>
  );
}
