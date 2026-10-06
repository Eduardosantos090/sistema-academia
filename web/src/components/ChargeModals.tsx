import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { Charge, Customer, Paged, SendResult, Template } from '../api/types';
import { addDaysIso, centsToInput, fmtCents, fmtDate, methodLabel, parseMoneyToCents, todayIso } from '../lib/format';
import { Alert, Button, Checkbox, Modal, SelectField, TextArea, TextField, WhatsAppLink, fieldErrors, useToast } from './ui';
import { Icon, WhatsAppIcon } from './icons';

/** Invalida tudo que mostra cobranças, clientes e contadores. */
export function useInvalidateFinance() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['charges', 'customers', 'customer', 'dashboard', 'counters', 'messages', 'subscriptions']) {
      void qc.invalidateQueries({ queryKey: [k] });
    }
  };
}

type ChargeLike = Pick<Charge, 'id' | 'description' | 'amountCents' | 'dueDate'> & { customerName?: string };

export function PayModal({ charge, onClose }: { charge: ChargeLike; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateFinance();
  const [paidOn, setPaidOn] = useState(todayIso());
  const [amount, setAmount] = useState(centsToInput(charge.amountCents));
  const [method, setMethod] = useState('pix');
  const [notify, setNotify] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [waLink, setWaLink] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ confirmation: SendResult | null }>(`/api/charges/${charge.id}/pay`, {
        paidOn,
        amountCents: parseMoneyToCents(amount) ?? undefined,
        method,
        notify,
      }),
    onSuccess: (r) => {
      invalidate();
      toast.success('Pagamento registrado.');
      if (r.confirmation?.waLink) setWaLink(r.confirmation.waLink);
      else onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível registrar.'),
  });
  if (waLink) {
    return (
      <Modal title="Enviar confirmação" onClose={onClose} footer={<Button onClick={onClose}>Fechar</Button>}>
        <div className="stack">
          <Alert kind="success">Pagamento registrado! A confirmação está pronta para enviar pelo WhatsApp.</Alert>
          <WhatsAppLink href={waLink} onOpened={onClose}>
            <WhatsAppIcon /> Abrir WhatsApp com a mensagem
          </WhatsAppLink>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="Registrar pagamento"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()} disabled={parseMoneyToCents(amount) === null}>
            <Icon name="check" /> Confirmar pagamento
          </Button>
        </>
      }
    >
      <div className="stack">
        {error && <Alert>{error}</Alert>}
        <p className="muted" style={{ margin: 0 }}>
          {charge.customerName && <strong style={{ color: 'var(--text)' }}>{charge.customerName} · </strong>}
          {charge.description} — {fmtCents(charge.amountCents)} — vence {fmtDate(charge.dueDate)}
        </p>
        <div className="form-grid">
          <TextField label="Data do pagamento" type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} />
          <TextField label="Valor recebido (R$)" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <SelectField label="Forma de pagamento" value={method} onChange={(e) => setMethod(e.target.value)}>
            {Object.entries(methodLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
        </div>
        <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)} label="Enviar confirmação de pagamento ao cliente" />
      </div>
    </Modal>
  );
}

export function SendModal({ charge, onClose }: { charge: ChargeLike & { customerPhone?: string | null; customerEmail?: string | null }; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateFinance();
  const [channel, setChannel] = useState<'whatsapp' | 'email'>(charge.customerPhone === null && charge.customerEmail ? 'email' : 'whatsapp');
  const [templateId, setTemplateId] = useState('');
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ items: Template[] }>('/api/templates') });
  const m = useMutation({
    mutationFn: () => api.post<SendResult>(`/api/charges/${charge.id}/send`, { channel, templateId: templateId || null }),
    onSuccess: (r) => {
      invalidate();
      if (r.waLink) setResult(r);
      else if (r.status === 'enviada') {
        toast.success('Mensagem enviada.');
        onClose();
      } else setResult(r);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível enviar.'),
  });
  return (
    <Modal title="Enviar lembrete agora" onClose={onClose} footer={!result && (
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>
          <Icon name="send" /> Enviar
        </Button>
      </>
    )}>
      {result ? (
        <div className="stack">
          {result.waLink ? (
            <>
              <Alert kind="info">
                O WhatsApp automático não está configurado: a mensagem está pronta, é só abrir e tocar em enviar.
              </Alert>
              <WhatsAppLink href={result.waLink} onOpened={() => {
                void api.post(`/api/messages/${result.messageId}/mark-sent`).then(invalidate).catch(() => undefined);
                onClose();
              }}>
                <WhatsAppIcon /> Abrir WhatsApp com a mensagem
              </WhatsAppLink>
            </>
          ) : (
            <Alert kind={result.status === 'falhou' ? 'error' : 'warning'}>
              {result.error ?? 'A mensagem ficou na fila e será reenviada automaticamente.'}
            </Alert>
          )}
        </div>
      ) : (
        <div className="stack">
          {error && <Alert>{error}</Alert>}
          <p className="muted" style={{ margin: 0 }}>
            {charge.customerName && <strong style={{ color: 'var(--text)' }}>{charge.customerName} · </strong>}
            {charge.description} — {fmtCents(charge.amountCents)} — vence {fmtDate(charge.dueDate)}
          </p>
          <div className="radio-cards">
            <label className="radio-card">
              <input type="radio" name="ch" checked={channel === 'whatsapp'} onChange={() => setChannel('whatsapp')} />
              <span><strong className="row-sm"><WhatsAppIcon /> WhatsApp</strong><span className="muted small">Mais lido e rápido</span></span>
            </label>
            <label className="radio-card">
              <input type="radio" name="ch" checked={channel === 'email'} onChange={() => setChannel('email')} />
              <span><strong className="row-sm"><Icon name="mail" /> E-mail</strong><span className="muted small">Com link de descadastro</span></span>
            </label>
          </div>
          <SelectField label="Modelo da mensagem" value={templateId} onChange={(e) => setTemplateId(e.target.value)} hint="Automático: escolhe lembrete, vencimento ou atraso conforme a data.">
            <option value="">Automático (recomendado)</option>
            {templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </SelectField>
        </div>
      )}
    </Modal>
  );
}

export function NewChargeModal({ customer, onClose }: { customer?: Pick<Customer, 'id' | 'name'>; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidateFinance();
  const [customerId, setCustomerId] = useState(customer?.id ?? '');
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ description: '', amount: '', dueDate: addDaysIso(todayIso(), 7), paymentLink: '', notes: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const customers = useQuery({
    queryKey: ['customers', 'picker', q],
    queryFn: () => api.get<Paged<Customer>>(`/api/customers?pageSize=20&q=${encodeURIComponent(q)}`),
    enabled: !customer,
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () =>
      api.post('/api/charges', {
        customerId,
        description: form.description,
        amountCents: parseMoneyToCents(form.amount) ?? 0,
        dueDate: form.dueDate,
        paymentLink: form.paymentLink || null,
        notes: form.notes || null,
      }),
    onSuccess: () => {
      invalidate();
      toast.success('Cobrança criada.');
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof ApiError ? e.message : 'Não foi possível criar.');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Modal title="Nova cobrança avulsa" onClose={onClose}>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        {customer ? (
          <p style={{ margin: 0 }}>Cliente: <strong>{customer.name}</strong></p>
        ) : (
          <div className="form-grid">
            <TextField label="Buscar cliente" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, e-mail ou telefone" />
            <SelectField label="Cliente" value={customerId} onChange={(e) => setCustomerId(e.target.value)} error={errors.customerId} required>
              <option value="">Selecione…</option>
              {customers.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </SelectField>
          </div>
        )}
        <TextField label="Descrição" value={form.description} onChange={set('description')} error={errors.description} placeholder="Ex.: Matrícula, avaliação física, material…" required />
        <div className="form-grid">
          <TextField label="Valor (R$)" value={form.amount} onChange={set('amount')} error={errors.amountCents} inputMode="decimal" placeholder="0,00" required />
          <TextField label="Vencimento" type="date" value={form.dueDate} onChange={set('dueDate')} error={errors.dueDate} required />
        </div>
        <TextField label="Link de pagamento (opcional)" value={form.paymentLink} onChange={set('paymentLink')} error={errors.paymentLink} placeholder="https://…" hint="Ex.: link do Mercado Pago, PagSeguro ou do seu banco." />
        <TextArea label="Observações internas" value={form.notes} onChange={set('notes')} rows={2} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancelar</Button>
          <Button type="submit" variant="primary" loading={m.isPending} disabled={!customerId || !form.description || parseMoneyToCents(form.amount) === null}>
            Criar cobrança
          </Button>
        </div>
      </form>
    </Modal>
  );
}
