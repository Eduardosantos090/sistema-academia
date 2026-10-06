import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { Customer, Plan } from '../api/types';
import { addDaysIso, centsToInput, fmtCents, fmtPhone, intervalLabel, parseMoneyToCents, todayIso } from '../lib/format';
import { Alert, Button, Checkbox, Modal, SelectField, TextArea, TextField, fieldErrors, useToast } from './ui';
import { useInvalidateFinance } from './ChargeModals';

interface SubForm {
  enabled: boolean;
  planId: string;
  description: string;
  amount: string;
  intervalMonths: string;
  firstDueDate: string;
}

const emptySub = (): SubForm => ({ enabled: true, planId: '', description: '', amount: '', intervalMonths: '1', firstDueDate: addDaysIso(todayIso(), 3) });

function subPayload(s: SubForm) {
  return {
    planId: s.planId || null,
    description: s.planId ? null : s.description || null,
    amountCents: s.planId && !s.amount ? null : parseMoneyToCents(s.amount),
    intervalMonths: s.planId ? null : Number(s.intervalMonths),
    firstDueDate: s.firstDueDate,
  };
}

function SubscriptionFields({ value, onChange, plans, errors, prefix = '' }: {
  value: SubForm; onChange: (v: SubForm) => void; plans: Plan[]; errors: Record<string, string>; prefix?: string;
}) {
  const set = (k: keyof SubForm) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const plan = plans.find((p) => p.id === value.planId);
  return (
    <div className="form-grid">
      <SelectField label="Plano" value={value.planId} onChange={(e) => {
        const p = plans.find((x) => x.id === e.target.value);
        onChange({ ...value, planId: e.target.value, amount: p ? centsToInput(p.amountCents) : value.amount });
      }}>
        <option value="">Personalizado (sem plano)</option>
        {plans.filter((p) => p.isActive).map((p) => (
          <option key={p.id} value={p.id}>{p.name} — {fmtCents(p.amountCents)} / {intervalLabel[p.intervalMonths]?.toLowerCase()}</option>
        ))}
      </SelectField>
      <TextField label="Primeiro vencimento" type="date" value={value.firstDueDate} onChange={set('firstDueDate')} error={errors[`${prefix}firstDueDate`]}
        hint="Os próximos seguem o mesmo dia do mês." required />
      {!value.planId ? (
        <>
          <TextField label="Descrição" value={value.description} onChange={set('description')} placeholder="Ex.: Mensalidade" error={errors[`${prefix}description`]} />
          <SelectField label="Periodicidade" value={value.intervalMonths} onChange={set('intervalMonths')}>
            {Object.entries(intervalLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
          <TextField label="Valor (R$)" value={value.amount} onChange={set('amount')} inputMode="decimal" placeholder="0,00" error={errors[`${prefix}amountCents`]} />
        </>
      ) : (
        <TextField label="Valor (R$)" value={value.amount} onChange={set('amount')} inputMode="decimal"
          hint={plan ? `Valor do plano: ${fmtCents(plan.amountCents)}. Altere para dar desconto.` : undefined} error={errors[`${prefix}amountCents`]} />
      )}
    </div>
  );
}

export function CustomerFormModal({ customer, onClose, onSaved }: { customer?: Customer; onClose: () => void; onSaved?: (id: string) => void }) {
  const toast = useToast();
  const invalidate = useInvalidateFinance();
  const editing = !!customer;
  const [form, setForm] = useState({
    name: customer?.name ?? '',
    phone: customer?.phone ? fmtPhone(customer.phone) : '',
    email: customer?.email ?? '',
    document: customer?.document ?? '',
    notes: customer?.notes ?? '',
    whatsappOptIn: customer?.whatsappOptIn ?? true,
    emailOptIn: customer?.emailOptIn ?? true,
  });
  const [sub, setSub] = useState<SubForm>(emptySub());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ items: Plan[] }>('/api/plans'), enabled: !editing });
  const set = (k: 'name' | 'phone' | 'email' | 'document' | 'notes') => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const m = useMutation({
    mutationFn: () => {
      const base = {
        name: form.name,
        phone: form.phone || null,
        email: form.email || null,
        document: form.document || null,
        notes: form.notes || null,
        whatsappOptIn: form.whatsappOptIn,
        emailOptIn: form.emailOptIn,
      };
      return editing
        ? api.patch<{ ok: true }>(`/api/customers/${customer.id}`, base).then(() => ({ id: customer.id }))
        : api.post<{ id: string }>('/api/customers', { ...base, subscription: sub.enabled ? subPayload(sub) : null });
    },
    onSuccess: (r) => {
      invalidate();
      toast.success(editing ? 'Cliente atualizado.' : 'Cliente cadastrado.');
      onSaved?.(r.id);
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Modal title={editing ? 'Editar cliente' : 'Novo cliente'} onClose={onClose} size="lg">
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <div className="form-grid">
          <div className="full">
            <TextField label="Nome completo" value={form.name} onChange={set('name')} error={errors.name} required autoComplete="off" />
          </div>
          <TextField label="WhatsApp" value={form.phone} onChange={set('phone')} error={errors.phone} inputMode="tel" placeholder="(11) 90000-0000" />
          <TextField label="E-mail" type="email" value={form.email} onChange={set('email')} error={errors.email} />
          <TextField label="CPF ou CNPJ (opcional)" value={form.document} onChange={set('document')} error={errors.document} inputMode="numeric" />
          <div className="stack-sm" style={{ justifyContent: 'flex-end' }}>
            <Checkbox checked={form.whatsappOptIn} onChange={(e) => setForm((f) => ({ ...f, whatsappOptIn: e.target.checked }))} label="Aceita receber avisos por WhatsApp" />
            <Checkbox checked={form.emailOptIn} onChange={(e) => setForm((f) => ({ ...f, emailOptIn: e.target.checked }))} label="Aceita receber avisos por e-mail" />
          </div>
          <div className="full">
            <TextArea label="Observações internas" value={form.notes} onChange={set('notes')} rows={2} error={errors.notes} />
          </div>
        </div>
        {!editing && (
          <div className="card card-body stack" style={{ background: 'var(--bg-2)' }}>
            <Checkbox checked={sub.enabled} onChange={(e) => setSub({ ...sub, enabled: e.target.checked })} label="Criar assinatura recorrente (gera as cobranças automaticamente)" />
            {sub.enabled && <SubscriptionFields value={sub} onChange={setSub} plans={plans.data?.items ?? []} errors={errors} prefix="subscription." />}
          </div>
        )}
        <Alert kind="info">
          Cadastre somente clientes que autorizaram o contato. O cliente pode pedir para parar de receber avisos a qualquer
          momento (respondendo SAIR no WhatsApp ou pelo link no e-mail).
        </Alert>
        <div className="form-actions">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={form.name.trim().length < 2}>
            {editing ? 'Salvar' : 'Cadastrar cliente'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function SubscriptionModal({ customer, onClose }: { customer: Pick<Customer, 'id' | 'name'>; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateFinance();
  const [sub, setSub] = useState<SubForm>(emptySub());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<{ items: Plan[] }>('/api/plans') });
  const m = useMutation({
    mutationFn: () => api.post('/api/subscriptions', { customerId: customer.id, ...subPayload(sub) }),
    onSuccess: () => {
      invalidate();
      toast.success('Assinatura criada. As cobranças dos próximos 30 dias já foram geradas.');
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof ApiError ? e.message : 'Não foi possível criar.');
    },
  });
  return (
    <Modal title={`Nova assinatura — ${customer.name}`} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Criar assinatura</Button>
      </>
    }>
      <div className="stack">
        {error && <Alert>{error}</Alert>}
        <SubscriptionFields value={sub} onChange={setSub} plans={plans.data?.items ?? []} errors={errors} />
      </div>
    </Modal>
  );
}
