import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Charge, CustomerDetail, Subscription } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  Button, ChargeBadge, ConfirmDialog, Empty, ErrorState, Loading, MessageBadge, PageHeader, Tabs, useToast, usePageTitle,
} from '../../components/ui';
import { Icon, WhatsAppIcon } from '../../components/icons';
import { NewChargeModal, PayModal, SendModal, useInvalidateFinance } from '../../components/ChargeModals';
import { CustomerFormModal, SubscriptionModal } from '../../components/CustomerModals';
import { fmtCents, fmtDate, fmtDateTime, fmtDocument, fmtPhone, intervalLabel, methodLabel } from '../../lib/format';

type Tab = 'cobrancas' | 'assinaturas' | 'mensagens';

export function CustomerPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { isOwner } = useAuth();
  const invalidate = useInvalidateFinance();
  const [tab, setTab] = useState<Tab>('cobrancas');
  const [editing, setEditing] = useState(false);
  const [newSub, setNewSub] = useState(false);
  const [newCharge, setNewCharge] = useState(false);
  const [pay, setPay] = useState<Charge | null>(null);
  const [send, setSend] = useState<Charge | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; action: () => Promise<unknown>; danger?: boolean; requireText?: string; label: string }>(null);
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<CustomerDetail>(`/api/customers/${id}`) });
  usePageTitle('Cliente');
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      invalidate();
      setConfirm(null);
    },
    onError: (e) => toast.error(e),
  });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const ask = (x: NonNullable<typeof confirm>) => setConfirm(x);
  const subAction = (s: Subscription, status: Subscription['status']) =>
    ask({
      title: status === 'cancelada' ? 'Cancelar assinatura' : status === 'pausada' ? 'Pausar assinatura' : 'Retomar assinatura',
      message:
        status === 'cancelada'
          ? 'As cobranças futuras em aberto desta assinatura serão canceladas. Cobranças já vencidas continuam.'
          : status === 'pausada'
            ? 'Novas cobranças deixam de ser geradas até a retomada. As cobranças já existentes continuam.'
            : 'A assinatura volta a gerar cobranças a partir do próximo vencimento.',
      label: 'Confirmar',
      danger: status === 'cancelada',
      action: () => api.patch(`/api/subscriptions/${s.id}`, { status }),
    });
  const chargeCtx = (ch: Charge) => ({ ...ch, customerName: c.name, customerPhone: c.phone, customerEmail: c.email });

  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader
        breadcrumb={<Link to="/app/clientes">Clientes</Link>}
        title={c.name}
        subtitle={
          <span className="row-sm">
            {!c.isActive ? <span className="badge">Inativo</span> : c.overdueCount ? <span className="badge badge-danger">{fmtCents(c.overdueCents)} em atraso</span> : <span className="badge badge-success">Em dia</span>}
            <span className="muted small">Cliente desde {fmtDate(c.createdAt)}</span>
          </span>
        }
        actions={
          <>
            {c.conversation && <Link className="btn" to={`/app/atendimento?c=${c.conversation.id}`}><Icon name="chat" /> Conversa</Link>}
            <Button onClick={() => setEditing(true)}><Icon name="edit" /> Editar</Button>
            <Button variant="primary" onClick={() => setNewCharge(true)} disabled={!c.isActive}><Icon name="plus" /> Cobrança avulsa</Button>
          </>
        }
      />

      <div className="grid grid-main">
        <div className="card">
          <Tabs<Tab>
            label="Dados do cliente"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'cobrancas', label: `Cobranças (${c.charges.length})` },
              { id: 'assinaturas', label: `Assinaturas (${c.subscriptions.filter((s) => s.status !== 'cancelada').length})` },
              { id: 'mensagens', label: 'Mensagens' },
            ]}
          />
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'cobrancas' &&
              (c.charges.length === 0 ? (
                <Empty title="Nenhuma cobrança ainda" icon="receipt" />
              ) : (
                <div className="table-wrap">
                  <table className="table responsive">
                    <thead><tr><th>Vencimento</th><th>Descrição</th><th className="right">Valor</th><th>Situação</th><th className="actions">Ações</th></tr></thead>
                    <tbody>
                      {c.charges.map((ch) => (
                        <tr key={ch.id}>
                          <td data-label="Vencimento" className="num">{fmtDate(ch.dueDate)}</td>
                          <td data-label="Descrição">
                            {ch.description}
                            {ch.status === 'paga' && <div className="tiny muted">Pago em {fmtDateTime(ch.paidAt)} · {methodLabel[ch.paymentMethod ?? ''] ?? ''}</div>}
                          </td>
                          <td data-label="Valor" className="right num">{fmtCents(ch.status === 'paga' ? ch.paidAmountCents ?? ch.amountCents : ch.amountCents)}</td>
                          <td data-label="Situação"><ChargeBadge charge={ch} /></td>
                          <td className="actions">
                            {ch.status === 'aberta' && (
                              <div className="row-sm" style={{ justifyContent: 'flex-end' }}>
                                <Button size="sm" variant="ghost" className="btn-icon" title="Enviar lembrete" aria-label="Enviar lembrete" onClick={() => setSend(ch)}><Icon name="send" size={16} /></Button>
                                <Button size="sm" onClick={() => setPay(ch)}><Icon name="check" size={16} /> Pago</Button>
                                <Button size="sm" variant="ghost" className="btn-icon" title="Cancelar cobrança" aria-label="Cancelar cobrança"
                                  onClick={() => ask({ title: 'Cancelar cobrança', message: `Cancelar "${ch.description}" de ${fmtCents(ch.amountCents)}? Lembretes pendentes também serão cancelados.`, label: 'Cancelar cobrança', danger: true, action: () => api.post(`/api/charges/${ch.id}/cancel`) })}>
                                  <Icon name="x" size={16} />
                                </Button>
                              </div>
                            )}
                            {ch.status === 'paga' && (
                              <Button size="sm" variant="ghost" onClick={() => ask({ title: 'Estornar pagamento', message: 'A cobrança volta a ficar em aberto. Use se o pagamento foi registrado por engano.', label: 'Estornar', danger: true, action: () => api.post(`/api/charges/${ch.id}/unpay`) })}>
                                Estornar
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            {tab === 'assinaturas' && (
              <div>
                <div className="card-body row between">
                  <span className="muted small">As assinaturas geram as cobranças automaticamente, 30 dias antes de cada vencimento.</span>
                  <Button size="sm" variant="primary" onClick={() => setNewSub(true)} disabled={!c.isActive}><Icon name="plus" size={16} /> Nova assinatura</Button>
                </div>
                {c.subscriptions.length === 0 ? (
                  <Empty title="Sem assinaturas" icon="repeat" />
                ) : (
                  <ul className="list">
                    {c.subscriptions.map((s) => (
                      <li key={s.id} className="list-item">
                        <div className="grow">
                          <span className="title">{s.description}</span>
                          <span className="sub">
                            {fmtCents(s.amountCents)} · {intervalLabel[s.intervalMonths]} · todo dia {s.billingDay}
                            {s.status === 'ativa' && <> · próxima geração: {fmtDate(s.nextDueDate)}</>}
                          </span>
                        </div>
                        <span className={`badge ${s.status === 'ativa' ? 'badge-success' : s.status === 'pausada' ? 'badge-warning' : ''}`}>{s.status}</span>
                        {s.status === 'ativa' && <Button size="sm" onClick={() => subAction(s, 'pausada')}><Icon name="pause" size={14} /> Pausar</Button>}
                        {s.status === 'pausada' && <Button size="sm" onClick={() => subAction(s, 'ativa')}><Icon name="play" size={14} /> Retomar</Button>}
                        {s.status !== 'cancelada' && <Button size="sm" variant="danger" onClick={() => subAction(s, 'cancelada')}>Cancelar</Button>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {tab === 'mensagens' &&
              (c.messages.length === 0 ? (
                <Empty title="Nenhuma mensagem enviada" icon="send" />
              ) : (
                <ul className="list">
                  {c.messages.map((m) => (
                    <li key={m.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                      <span style={{ color: m.channel === 'whatsapp' ? 'var(--whatsapp)' : 'var(--info)', marginTop: 2 }}>
                        {m.channel === 'whatsapp' ? <WhatsAppIcon /> : <Icon name="mail" />}
                      </span>
                      <div className="grow">
                        <div className="row-sm"><MessageBadge status={m.status} /><span className="tiny muted">{fmtDateTime(m.sentAt ?? m.createdAt)}</span></div>
                        <div className="small pre-wrap" style={{ marginTop: 6 }}>{m.body}</div>
                        {m.error && <div className="tiny red" style={{ marginTop: 4 }}>{m.error}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        </div>

        <aside className="stack">
          <section className="card card-body stack-sm">
            <h2>Contato</h2>
            <dl className="dl">
              <dt>WhatsApp</dt>
              <dd>
                {c.phone ? (
                  <span className="row-sm">{fmtPhone(c.phone)} {!c.whatsappOptIn && <span className="badge badge-warning">não recebe avisos</span>}</span>
                ) : '—'}
              </dd>
              <dt>E-mail</dt>
              <dd>
                {c.email ? <span className="row-sm">{c.email} {!c.emailOptIn && <span className="badge badge-warning">descadastrado</span>}</span> : '—'}
              </dd>
              <dt>CPF/CNPJ</dt>
              <dd>{fmtDocument(c.document)}</dd>
            </dl>
            {c.notes && <div className="code-box small pre-wrap">{c.notes}</div>}
          </section>
          <section className="card card-body stack-sm">
            <h2>Resumo</h2>
            <dl className="dl">
              <dt>Em aberto</dt><dd>{c.openCount} cobrança(s)</dd>
              <dt>Em atraso</dt><dd className={c.overdueCount ? 'red' : ''}>{c.overdueCount ? `${c.overdueCount} · ${fmtCents(c.overdueCents)}` : 'nenhuma'}</dd>
              <dt>Próximo vencimento</dt><dd>{fmtDate(c.nextDueDate)}</dd>
            </dl>
          </section>
          <section className="card card-body stack-sm">
            <h2>Gerenciar</h2>
            {c.isActive ? (
              <Button onClick={() => ask({ title: 'Desativar cliente', message: 'As assinaturas serão pausadas e envios pendentes cancelados. Você pode reativar depois.', label: 'Desativar', danger: true, action: () => api.patch(`/api/customers/${c.id}`, { isActive: false }) })}>
                <Icon name="pause" /> Desativar cliente
              </Button>
            ) : (
              <Button onClick={() => run.mutate(() => api.patch(`/api/customers/${c.id}`, { isActive: true }))}><Icon name="play" /> Reativar cliente</Button>
            )}
            {isOwner && (
              <Button variant="danger" onClick={() => ask({
                title: 'Excluir dados do cliente',
                message: 'Exclusão definitiva (ex.: pedido do titular pela LGPD): remove o cadastro, cobranças, assinaturas, mensagens e conversas deste cliente. Não pode ser desfeita.',
                label: 'Excluir definitivamente', danger: true, requireText: 'EXCLUIR',
                action: () => api.delete(`/api/customers/${c.id}`).then(() => nav('/app/clientes')),
              })}>
                <Icon name="trash" /> Excluir dados (LGPD)
              </Button>
            )}
          </section>
        </aside>
      </div>

      {editing && <CustomerFormModal customer={c} onClose={() => setEditing(false)} />}
      {newSub && <SubscriptionModal customer={c} onClose={() => setNewSub(false)} />}
      {newCharge && <NewChargeModal customer={c} onClose={() => setNewCharge(false)} />}
      {pay && <PayModal charge={chargeCtx(pay)} onClose={() => setPay(null)} />}
      {send && <SendModal charge={chargeCtx(send)} onClose={() => setSend(null)} />}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          requireText={confirm.requireText}
          loading={run.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={() => run.mutate(confirm.action)}
        />
      )}
    </div>
  );
}
