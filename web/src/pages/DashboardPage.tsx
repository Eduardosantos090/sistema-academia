import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Charge } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Button, Empty, ErrorState, Loading, PageHeader, usePageTitle } from '../components/ui';
import { Icon, WhatsAppIcon, type IconName } from '../components/icons';
import { Donut, RevenueChart, type SeriesPoint } from '../components/charts';
import { PayModal, SendModal } from '../components/ChargeModals';
import { CustomerFormModal } from '../components/CustomerModals';
import { datePill, fmtCents, relDays } from '../lib/format';

interface DashRow extends Pick<Charge, 'id' | 'description' | 'amountCents' | 'dueDate' | 'reportedPaidAt'> {
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  daysLate: number;
}

interface Dashboard {
  today: string;
  receivableMonthCents: number;
  receivedMonthCents: number;
  receivedMonthCount: number;
  overdueCents: number;
  overdueCount: number;
  overdueCustomers: number;
  dueSoonCount: number;
  dueSoonCents: number;
  dueTodayCount: number;
  toConfirmCount: number;
  activeCustomers: number;
  activeSubscriptions: number;
  waitingConversations: number;
  manualQueue: number;
  failedMessages: number;
  sent30d: number;
  onTimeRate: number | null;
  series: SeriesPoint[];
  upcoming: DashRow[];
  overdue: DashRow[];
  toConfirm: DashRow[];
}

function Stat({ icon, label, value, meta, tone, to }: { icon: IconName; label: string; value: string; meta?: string; tone?: 'danger' | 'warning' | 'info'; to?: string }) {
  return (
    <div className={`card stat ${tone ?? ''}`}>
      <div className="stat-icon"><Icon name={icon} /></div>
      <div className="label">{to ? <Link to={to} className="stretched" style={{ color: 'inherit', textDecoration: 'none' }}>{label}</Link> : label}</div>
      <div className="value">{value}</div>
      {meta && <div className="meta">{meta}</div>}
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

export function DashboardPage() {
  usePageTitle('Painel');
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/api/dashboard'), refetchInterval: 60_000 });
  const [pay, setPay] = useState<DashRow | null>(null);
  const [send, setSend] = useState<DashRow | null>(null);
  const [newCustomer, setNewCustomer] = useState(false);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const first = user?.fullName.split(' ')[0];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <PageHeader
        title={`${greeting()}, ${first}!`}
        subtitle={
          d.dueTodayCount
            ? `${d.dueTodayCount} cobrança(s) vencem hoje. Os lembretes saem automaticamente no horário configurado.`
            : 'Acompanhe recebimentos, vencimentos e o que precisa da sua atenção.'
        }
        actions={
          <>
            <Link to="/app/cobrancas?filtro=atrasadas" className="btn"><Icon name="alert" /> Ver atrasados</Link>
            <Button variant="primary" onClick={() => setNewCustomer(true)}><Icon name="plus" /> Novo cliente</Button>
          </>
        }
      />

      {(d.toConfirmCount > 0 || d.waitingConversations > 0 || d.manualQueue > 0 || d.failedMessages > 0) && (
        <div className="grid grid-4">
          {d.toConfirmCount > 0 && (
            <Link to="/app/cobrancas?filtro=a_conferir" className="card card-body row-sm card-glow" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="green"><Icon name="checkCircle" /></span>
              <span><strong>{d.toConfirmCount}</strong> pagamento(s) informado(s) para conferir</span>
            </Link>
          )}
          {d.waitingConversations > 0 && (
            <Link to="/app/atendimento" className="card card-body row-sm card-glow" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="green"><Icon name="chat" /></span>
              <span><strong>{d.waitingConversations}</strong> conversa(s) aguardando atendente</span>
            </Link>
          )}
          {d.manualQueue > 0 && (
            <Link to="/app/mensagens?status=manual" className="card card-body row-sm" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span style={{ color: 'var(--whatsapp)' }}><WhatsAppIcon /></span>
              <span><strong>{d.manualQueue}</strong> lembrete(s) prontos para enviar no WhatsApp</span>
            </Link>
          )}
          {d.failedMessages > 0 && (
            <Link to="/app/mensagens?status=falhou" className="card card-body row-sm" style={{ textDecoration: 'none', color: 'inherit' }}>
              <span className="red"><Icon name="alert" /></span>
              <span><strong>{d.failedMessages}</strong> envio(s) com falha nos últimos 7 dias</span>
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-4">
        <Stat icon="trending" label="Recebido no mês" value={fmtCents(d.receivedMonthCents)} meta={`${d.receivedMonthCount} pagamento(s)`} />
        <Stat icon="calendar" label="A receber no mês" value={fmtCents(d.receivableMonthCents)} meta={`${d.dueSoonCount} vencendo nos próximos 7 dias`} tone="info" to="/app/cobrancas?filtro=vencendo" />
        <Stat icon="alert" label="Em atraso" value={fmtCents(d.overdueCents)} meta={`${d.overdueCount} cobrança(s) · ${d.overdueCustomers} cliente(s)`} tone="danger" to="/app/cobrancas?filtro=atrasadas" />
        <Stat icon="users" label="Clientes ativos" value={String(d.activeCustomers)} meta={`${d.activeSubscriptions} assinatura(s) ativa(s)`} tone="warning" to="/app/clientes" />
      </div>

      <div className="grid grid-main">
        <section className="card" aria-labelledby="chart-title">
          <div className="card-header">
            <h2 id="chart-title">Recebimentos dos últimos 6 meses</h2>
          </div>
          <div className="card-body">
            <RevenueChart data={d.series} />
          </div>
        </section>
        <section className="card" aria-labelledby="rate-title">
          <div className="card-header">
            <h2 id="rate-title">Adimplência</h2>
            <span className="muted small">últimos 30 dias</span>
          </div>
          <div className="card-body row" style={{ gap: 20 }}>
            <Donut value={d.onTimeRate} label="Cobranças vencidas nos últimos 30 dias que já foram pagas" />
            <div className="stack-sm" style={{ flex: 1, minWidth: 160 }}>
              <span className="muted small">Das cobranças vencidas nos últimos 30 dias, quantas já foram pagas.</span>
              <div className="row-sm"><Icon name="send" /><span><strong>{d.sent30d}</strong> mensagens enviadas em 30 dias</span></div>
              <div className="row-sm"><Icon name="repeat" /><span><strong>{d.activeSubscriptions}</strong> assinaturas gerando cobranças</span></div>
            </div>
          </div>
        </section>
      </div>

      <div className="grid grid-2">
        <ChargeList title="Próximos vencimentos" rows={d.upcoming} today={d.today} empty="Nenhum vencimento nos próximos 7 dias." link="/app/cobrancas?filtro=vencendo" onPay={setPay} onSend={setSend} />
        <ChargeList title="Em atraso" rows={d.overdue} today={d.today} empty="Ninguém em atraso. 🎉" link="/app/cobrancas?filtro=atrasadas" onPay={setPay} onSend={setSend} late />
      </div>

      {d.toConfirm.length > 0 && (
        <ChargeList title="Pagamentos informados pelo assistente (conferir)" rows={d.toConfirm} today={d.today} empty="" link="/app/cobrancas?filtro=a_conferir" onPay={setPay} onSend={setSend} />
      )}

      {pay && <PayModal charge={pay} onClose={() => setPay(null)} />}
      {send && <SendModal charge={send} onClose={() => setSend(null)} />}
      {newCustomer && <CustomerFormModal onClose={() => setNewCustomer(false)} />}
    </div>
  );
}

function ChargeList({ title, rows, today, empty, link, onPay, onSend, late }: {
  title: string; rows: DashRow[]; today: string; empty: string; link: string; onPay: (r: DashRow) => void; onSend: (r: DashRow) => void; late?: boolean;
}) {
  return (
    <section className="card">
      <div className="card-header">
        <h2>{title}</h2>
        <Link to={link} className="small">Ver todos</Link>
      </div>
      {rows.length === 0 ? (
        <Empty title={empty} icon="calendarCheck" />
      ) : (
        <ul className="list">
          {rows.map((r) => {
            const p = datePill(r.dueDate);
            return (
              <li key={r.id} className="list-item">
                <div className={`date-pill ${r.daysLate > 0 ? 'late' : r.dueDate === today ? 'today' : ''}`} aria-hidden>
                  <b>{p.day}</b><span>{p.month}</span>
                </div>
                <div className="grow">
                  <Link to={`/app/clientes/${r.customerId}`} className="title">{r.customerName}</Link>
                  <div className="sub">
                    {r.description} · <span className="num">{fmtCents(r.amountCents)}</span> ·{' '}
                    <span className={late ? 'red' : ''}>{r.daysLate > 0 ? `atrasada ${relDays(r.daysLate)}` : r.daysLate === 0 ? 'vence hoje' : `vence ${relDays(r.daysLate)}`}</span>
                    {r.reportedPaidAt && <> · <span className="badge badge-info">informou pagamento</span></>}
                  </div>
                </div>
                <div className="row-sm">
                  <Button size="sm" variant="ghost" className="btn-icon" onClick={() => onSend(r)} aria-label={`Enviar lembrete para ${r.customerName}`} title="Enviar lembrete">
                    <Icon name="send" size={16} />
                  </Button>
                  <Button size="sm" onClick={() => onPay(r)} title="Registrar pagamento">
                    <Icon name="check" size={16} /> Pago
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
