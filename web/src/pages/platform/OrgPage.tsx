import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import type { InviteResult, TeamUser } from '../../api/types';
import { Alert, Button, ConfirmDialog, ErrorState, Loading, Modal, PageHeader, SecretLink, SelectField, TextField, fieldErrors, useToast, usePageTitle } from '../../components/ui';
import { Icon } from '../../components/icons';
import { fmtDateTime, fmtPhone, roleLabel, segmentLabel } from '../../lib/format';

interface OrgDetail {
  id: string; name: string; slug: string; segment: string; contactEmail: string | null; contactPhone: string | null; isActive: boolean;
  createdAt: string; users: TeamUser[]; mailMode: string;
}

export function OrgPage() {
  usePageTitle('Organização');
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['org', id], queryFn: () => api.get<OrgDetail>(`/api/platform/orgs/${id}`) });
  const [link, setLink] = useState<{ link: string; hours?: number; kind: 'convite' | 'redefinição' } | null>(null);
  const [adding, setAdding] = useState(false);
  const [suspend, setSuspend] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['org', id] });
    void qc.invalidateQueries({ queryKey: ['orgs'] });
  };
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/platform/orgs/${id}`, body),
    onSuccess: () => {
      refresh();
      setSuspend(false);
    },
    onError: (e) => toast.error(e),
  });
  const userAct = useMutation({
    mutationFn: ({ uid, action }: { uid: string; action: 'invite' | 'reset-link' }) => api.post<InviteResult>(`/api/platform/users/${uid}/${action}`),
    onSuccess: (r) => {
      if (r.inviteLink) setLink({ link: r.inviteLink, hours: r.validHours, kind: 'convite' });
      else if (r.resetLink) setLink({ link: r.resetLink, hours: r.validHours, kind: 'redefinição' });
      else toast.success('Convite enviado por e-mail.');
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  const toggleUser = useMutation({
    mutationFn: (u: TeamUser) => api.patch(`/api/platform/users/${u.id}`, { isActive: !u.isActive }),
    onSuccess: refresh,
    onError: (e) => toast.error(e),
  });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} />;
  const o = q.data;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader
        breadcrumb={<Link to="/app/plataforma">Organizações</Link>}
        title={o.name}
        subtitle={<span className="row-sm"><span className={`badge ${o.isActive ? 'badge-success' : 'badge-danger'}`}>{o.isActive ? 'Ativa' : 'Suspensa'}</span><span className="muted small">{segmentLabel[o.segment]} · desde {fmtDateTime(o.createdAt)}</span></span>}
        actions={
          <>
            <Button onClick={() => setAdding(true)}><Icon name="plus" /> Adicionar usuário</Button>
            {o.isActive ? <Button variant="danger" onClick={() => setSuspend(true)}>Suspender</Button> : <Button variant="primary" onClick={() => patch.mutate({ isActive: true })}>Reativar</Button>}
          </>
        }
      />
      {link && <div className="card card-body"><SecretLink link={link.link} hours={link.hours} kind={link.kind} /></div>}
      <div className="grid grid-main">
        <section className="card">
          <div className="card-header"><h2>Usuários</h2></div>
          <ul className="list">
            {o.users.map((u) => (
              <li key={u.id} className="list-item">
                <div className="grow">
                  <span className="title">{u.fullName}</span>
                  <span className="sub">{u.email} · {roleLabel[u.role]} · último acesso {fmtDateTime(u.lastLoginAt)}</span>
                </div>
                <span className={`badge ${u.accessStatus === 'ativo' ? 'badge-success' : u.accessStatus === 'desativado' ? '' : 'badge-warning'}`}>{u.accessStatus.replace('_', ' ')}</span>
                {u.accessStatus.startsWith('convite') && <Button size="sm" onClick={() => userAct.mutate({ uid: u.id, action: 'invite' })}>Reenviar convite</Button>}
                {u.accessStatus === 'ativo' && o.mailMode === 'manual' && <Button size="sm" onClick={() => userAct.mutate({ uid: u.id, action: 'reset-link' })}>Link de nova senha</Button>}
                <Button size="sm" variant={u.isActive ? 'danger' : 'default'} onClick={() => toggleUser.mutate(u)}>{u.isActive ? 'Desativar' : 'Reativar'}</Button>
              </li>
            ))}
          </ul>
        </section>
        <section className="card card-body stack-sm">
          <h2>Contato</h2>
          <dl className="dl">
            <dt>E-mail</dt><dd>{o.contactEmail ?? '—'}</dd>
            <dt>Telefone</dt><dd>{fmtPhone(o.contactPhone)}</dd>
            <dt>Endereço interno</dt><dd className="mono">{o.slug}</dd>
          </dl>
        </section>
      </div>
      {adding && <AddUserModal orgId={o.id} onClose={() => setAdding(false)} onLink={setLink} />}
      {suspend && (
        <ConfirmDialog title="Suspender organização" danger confirmLabel="Suspender" loading={patch.isPending} requireText="SUSPENDER"
          message="Todos os usuários perdem o acesso e as automações (lembretes e assistente) param até a reativação. Os dados são mantidos."
          onCancel={() => setSuspend(false)} onConfirm={() => patch.mutate({ isActive: false })} />
      )}
    </div>
  );
}

function AddUserModal({ orgId, onClose, onLink }: { orgId: string; onClose: () => void; onLink: (l: { link: string; hours?: number; kind: 'convite' }) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'staff'>('owner');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api.post<InviteResult>(`/api/platform/orgs/${orgId}/users`, { fullName, email, role }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
      if (r.inviteLink) onLink({ link: r.inviteLink, hours: r.validHours, kind: 'convite' });
      else toast.success('Convite enviado por e-mail.');
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof ApiError ? e.message : 'Não foi possível adicionar.');
    },
  });
  return (
    <Modal title="Adicionar usuário" onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} disabled={!fullName || !email} onClick={() => m.mutate()}>Convidar</Button>
      </>
    }>
      <div className="stack">
        {error && <Alert>{error}</Alert>}
        <TextField label="Nome" value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.fullName} />
        <TextField label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <SelectField label="Perfil" value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'staff')}>
          <option value="owner">Responsável</option>
          <option value="staff">Equipe</option>
        </SelectField>
      </div>
    </Modal>
  );
}
