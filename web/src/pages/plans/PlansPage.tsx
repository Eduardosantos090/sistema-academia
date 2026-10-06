import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../../api/client';
import type { Paged, Plan, Subscription } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  Alert, Button, Checkbox, Empty, ErrorState, Loading, Modal, PageHeader, Pagination, SearchInput, Segmented, SelectField, TextField,
  fieldErrors, useToast, usePageTitle,
} from '../../components/ui';
import { Icon } from '../../components/icons';
import { centsToInput, fmtCents, fmtDate, intervalLabel, parseMoneyToCents } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';

export function PlansPage() {
  usePageTitle('Planos e assinaturas');
  const { isOwner } = useAuth();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ items: Plan[] }>('/api/plans') });
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);

  return (
    <div className="stack" style={{ gap: 24 }}>
      <PageHeader
        title="Planos e assinaturas"
        subtitle="Planos são modelos de cobrança recorrente. Cada cliente pode ter uma ou mais assinaturas."
        actions={isOwner && <Button variant="primary" onClick={() => setEditing('new')}><Icon name="plus" /> Novo plano</Button>}
      />
      {plans.isLoading ? (
        <Loading />
      ) : plans.error ? (
        <ErrorState error={plans.error} />
      ) : !plans.data?.items.length ? (
        <div className="card"><Empty title="Nenhum plano cadastrado" icon="layers">
          <p className="small">Ex.: Plano Mensal R$ 129,90, Trimestral, Anual… {isOwner ? '' : 'Peça ao responsável para cadastrar.'}</p>
          {isOwner && <Button variant="primary" onClick={() => setEditing('new')}><Icon name="plus" /> Criar primeiro plano</Button>}
        </Empty></div>
      ) : (
        <div className="grid grid-3">
          {plans.data.items.map((p) => (
            <article key={p.id} className={`card card-body stack-sm ${p.isActive ? '' : 'faint'}`} style={{ opacity: p.isActive ? 1 : 0.6 }}>
              <div className="row between">
                <span className="eyebrow">{intervalLabel[p.intervalMonths]}</span>
                {!p.isActive && <span className="badge">Inativo</span>}
              </div>
              <h2>{p.name}</h2>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.7rem', fontWeight: 800 }} className="num">
                {fmtCents(p.amountCents)}
              </div>
              {p.description && <p className="muted small">{p.description}</p>}
              <div className="row between">
                <span className="muted small">{p.activeSubscriptions} assinatura(s) ativa(s)</span>
                {isOwner && <Button size="sm" onClick={() => setEditing(p)}><Icon name="edit" size={14} /> Editar</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
      <SubscriptionsList />
      {editing && <PlanModal plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SubscriptionsList() {
  const [status, setStatus] = useState<'ativa' | 'pausada' | 'cancelada'>('ativa');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q, 300);
  const list = useQuery({
    queryKey: ['subscriptions', status, dq, page],
    queryFn: () => api.get<Paged<Subscription>>(`/api/subscriptions${qs({ status, q: dq, page, pageSize: 20 })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <section>
      <div className="row between" style={{ marginBottom: 12 }}>
        <h2>Assinaturas</h2>
      </div>
      <div className="toolbar">
        <Segmented label="Situação" value={status} onChange={(v) => { setStatus(v); setPage(1); }}
          options={[{ id: 'ativa', label: 'Ativas' }, { id: 'pausada', label: 'Pausadas' }, { id: 'cancelada', label: 'Canceladas' }]} />
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Cliente ou plano" label="Buscar assinaturas" />
      </div>
      <div className="card">
        {list.isLoading ? <Loading /> : !list.data?.items.length ? (
          <Empty title="Nenhuma assinatura" icon="repeat"><p className="small">Crie assinaturas na ficha de cada cliente.</p></Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table responsive">
                <thead><tr><th>Cliente</th><th>Plano / descrição</th><th className="right">Valor</th><th>Periodicidade</th><th>Próxima geração</th></tr></thead>
                <tbody>
                  {list.data.items.map((s) => (
                    <tr key={s.id}>
                      <td data-label="Cliente"><Link to={`/app/clientes/${s.customerId}`}>{s.customerName}</Link></td>
                      <td data-label="Plano">{s.description}</td>
                      <td data-label="Valor" className="right num">{fmtCents(s.amountCents)}</td>
                      <td data-label="Periodicidade">{intervalLabel[s.intervalMonths]}</td>
                      <td data-label="Próxima geração" className="num">{s.status === 'ativa' ? fmtDate(s.nextDueDate) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          </>
        )}
      </div>
    </section>
  );
}

function PlanModal({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [amount, setAmount] = useState(centsToInput(plan?.amountCents));
  const [interval, setInterval] = useState(String(plan?.intervalMonths ?? 1));
  const [isActive, setIsActive] = useState(plan?.isActive ?? true);
  const [apply, setApply] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const cents = parseMoneyToCents(amount);
  const m = useMutation({
    mutationFn: () => {
      const body = { name, description: description || null, amountCents: cents, intervalMonths: Number(interval) };
      return plan
        ? api.patch(`/api/plans/${plan.id}`, { ...body, isActive, applyToSubscriptions: apply })
        : api.post('/api/plans', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plans'] });
      void qc.invalidateQueries({ queryKey: ['subscriptions'] });
      toast.success('Plano salvo.');
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    },
  });
  return (
    <Modal title={plan ? 'Editar plano' : 'Novo plano'} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} disabled={!name || cents === null} onClick={() => m.mutate()}>Salvar</Button>
      </>
    }>
      <div className="stack">
        {error && <Alert>{error}</Alert>}
        <TextField label="Nome do plano" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="Ex.: Plano Mensal" required />
        <div className="form-grid">
          <TextField label="Valor (R$)" value={amount} onChange={(e) => setAmount(e.target.value)} error={errors.amountCents} inputMode="decimal" required />
          <SelectField label="Periodicidade" value={interval} onChange={(e) => setInterval(e.target.value)}>
            {Object.entries(intervalLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
        </div>
        <TextField label="Descrição (opcional)" value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} />
        {plan && (
          <>
            <Checkbox checked={isActive} onChange={(e) => setIsActive(e.target.checked)} label="Plano ativo (disponível para novas assinaturas)" />
            {cents !== plan.amountCents && (
              <Checkbox checked={apply} onChange={(e) => setApply(e.target.checked)} label="Aplicar o novo valor às assinaturas existentes (próximas cobranças)" />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
