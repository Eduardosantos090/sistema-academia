import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import type { InviteResult, TeamUser } from '../../api/types';
import { Alert, Button, ConfirmDialog, ErrorState, Loading, Modal, PageHeader, SecretLink, SelectField, Switch, TextField, fieldErrors, useToast, usePageTitle } from '../../components/ui';
import { AccessBadge } from './OrgsPage';
import { Icon } from '../../components/icons';
import { centsToInput, fmtDate, fmtDateTime, fmtPhone, intervalLabel, parseMoneyToCents, roleLabel, segmentLabel } from '../../lib/format';

interface OrgDetail {
  id: string; name: string; slug: string; segment: string; contactEmail: string | null; contactPhone: string | null; isActive: boolean;
  createdAt: string; users: TeamUser[]; mailMode: string;
  planName: string | null; planAmountCents: number | null; planIntervalMonths: number; accessUntil: string | null;
  accessDaysLeft: number | null; autoSuspend: boolean; graceDays: number; suspendedReason: string | null;
  autoBilling: boolean; isBillingOrg: boolean; subscriptionStatus?: 'ativa' | 'cancelada' | null;
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
        subtitle={<span className="row-sm"><AccessBadge o={o} /><span className="muted small">{segmentLabel[o.segment]} · desde {fmtDateTime(o.createdAt)}</span></span>}
        actions={
          <>
            <Button onClick={() => setAdding(true)}><Icon name="plus" /> Adicionar usuário</Button>
            {o.isActive ? <Button variant="danger" onClick={() => setSuspend(true)}>Suspender</Button> : <Button variant="primary" onClick={() => patch.mutate({ isActive: true })}>Reativar</Button>}
          </>
        }
      />
      {link && <div className="card card-body"><SecretLink link={link.link} hours={link.hours} kind={link.kind} /></div>}
      {!o.isBillingOrg && <PlanCard o={o} onChanged={refresh} />}
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

function PlanCard({ o, onChanged }: { o: OrgDetail; onChanged: () => void }) {
  const toast = useToast();
  const [planName, setPlanName] = useState(o.planName ?? '');
  const [amount, setAmount] = useState(centsToInput(o.planAmountCents));
  const [interval, setInterval] = useState(String(o.planIntervalMonths));
  const [accessUntil, setAccessUntil] = useState(o.accessUntil ?? '');
  const [autoSuspend, setAutoSuspend] = useState(o.autoSuspend);
  const [graceDays, setGraceDays] = useState(String(o.graceDays));
  const [firstDue, setFirstDue] = useState(o.accessUntil ?? '');
  const ok = (msg: string) => () => {
    onChanged();
    toast.success(msg);
  };
  const save = useMutation({
    mutationFn: () => api.put(`/api/platform/orgs/${o.id}/plan`, {
      planName: planName || null, amountCents: amount ? parseMoneyToCents(amount) : null, intervalMonths: Number(interval),
      accessUntil: accessUntil || null, autoSuspend, graceDays: Number(graceDays) || 0,
    }),
    onSuccess: ok('Plano salvo.'),
    onError: (e) => toast.error(e),
  });
  const extend = useMutation({
    mutationFn: (months: number) => api.post<{ accessUntil: string }>(`/api/platform/orgs/${o.id}/extend`, { months }),
    onSuccess: (r) => {
      setAccessUntil(r.accessUntil);
      ok(`Plano ativado até ${fmtDate(r.accessUntil)}.`)();
    },
    onError: (e) => toast.error(e),
  });
  const billing = useMutation({
    mutationFn: (enable: boolean) => api.post(`/api/platform/orgs/${o.id}/auto-billing`, { enable, firstDueDate: firstDue || undefined }),
    onSuccess: (_r, enable) => ok(enable ? 'Cobrança automática ativada.' : 'Cobrança automática desativada.')(),
    onError: (e) => toast.error(e),
  });
  return (
    <section className="card">
      <div className="card-header">
        <h2>Plano e acesso</h2>
        {o.subscriptionStatus && (
          <Alert kind={o.subscriptionStatus === 'ativa' ? 'success' : 'warning'}>
            {o.subscriptionStatus === 'ativa'
              ? 'Assinatura contratada pelo site (AbacatePay): cada renovação paga estende o acesso automaticamente.'
              : 'Assinatura cancelada na AbacatePay: o acesso termina na data abaixo (mais a tolerância) e a conta é suspensa.'}
          </Alert>
        )}
        <span className="row-sm">
          <AccessBadge o={o} />
          {o.accessUntil && <span className="muted small">até {fmtDate(o.accessUntil)}</span>}
        </span>
      </div>
      <div className="card-body stack">
        <div className="stack-sm">
          <strong>Ativar plano manualmente</strong>
          <span className="muted small">Libera (e reativa) o acesso a partir de hoje ou do fim do período atual.</span>
          <div className="row-sm">
            {[1, 3, 6, 12].map((m) => (
              <Button key={m} size="sm" variant={m === 1 ? 'primary' : 'default'} loading={extend.isPending && extend.variables === m} onClick={() => extend.mutate(m)}>
                <Icon name="plus" size={14} /> {m === 12 ? '1 ano' : `${m} ${m === 1 ? 'mês' : 'meses'}`}
              </Button>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <TextField label="Nome do plano" value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="Ex.: Profissional" />
          <TextField label="Valor (R$)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <SelectField label="Periodicidade" value={interval} onChange={(e) => setInterval(e.target.value)}>
            {Object.entries(intervalLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
          <TextField label="Acesso liberado até" type="date" value={accessUntil} onChange={(e) => setAccessUntil(e.target.value)} hint="Vazio = sem data limite." />
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Switch checked={autoSuspend} onChange={(e) => setAutoSuspend(e.target.checked)} label="Suspender automaticamente se vencer"
            hint="Bloqueia o acesso após a data acima + tolerância. Reativa sozinho quando o pagamento é registrado." />
          <div style={{ width: 160 }}>
            <TextField label="Tolerância (dias)" type="number" min={0} max={60} value={graceDays} onChange={(e) => setGraceDays(e.target.value)} />
          </div>
        </div>
        <div className="form-actions"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Salvar plano</Button></div>
        <div className="code-box stack-sm">
          <strong className="row-sm"><Icon name="repeat" /> Cobrança automática do plano</strong>
          {o.autoBilling ? (
            <>
              <span className="small muted">Ativa: a cobrança e os lembretes saem pela sua organização de cobrança. Ao registrar o pagamento lá, o acesso é renovado automaticamente.</span>
              <div><Button size="sm" variant="danger" loading={billing.isPending} onClick={() => billing.mutate(false)}>Desativar cobrança automática</Button></div>
            </>
          ) : (
            <>
              <span className="small muted">Cria esta empresa como cliente na sua organização de cobrança, com assinatura no valor do plano. Lembretes, PIX e confirmação saem automaticamente; o pagamento registrado renova o acesso.</span>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div style={{ width: 200 }}><TextField label="Primeiro vencimento" type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} /></div>
                <Button size="sm" variant="primary" loading={billing.isPending} disabled={!firstDue} onClick={() => billing.mutate(true)}>Ativar cobrança automática</Button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
