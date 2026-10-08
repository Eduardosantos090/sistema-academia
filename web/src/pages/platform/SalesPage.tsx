import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Alert, Button, CopyButton, Empty, ErrorState, Loading, PageHeader, Switch, TextField, fieldErrors, useToast, usePageTitle } from '../../components/ui';
import { fmtCents, fmtDateTime, fmtPhone } from '../../lib/format';

interface Signup {
  id: string; businessName: string; ownerName: string; email: string; phone: string | null;
  status: 'pendente' | 'ativo' | 'cancelado' | 'expirado'; error: string | null; createdAt: string; activatedAt: string | null; organizationId: string | null;
}
interface Sales {
  enabled: boolean; available: boolean; keyHint: string | null; productId: string | null; planName: string; priceCents: number;
  intervalMonths: number; methods: ('CARD' | 'PIX')[]; webhookUrl: string; webhookSecret: string | null; signups: Signup[];
}

const statusBadge: Record<Signup['status'], [string, string]> = {
  pendente: ['Aguardando pagamento', 'badge-warning'],
  ativo: ['Conta criada', 'badge-success'],
  cancelado: ['Cancelado', ''],
  expirado: ['Não concluído', ''],
};
const interval = (m: number) => (m === 1 ? 'mês' : m === 12 ? 'ano' : `${m} meses`);

/** Venda online da assinatura do Venceu (AbacatePay). */
export function SalesPage() {
  usePageTitle('Venda online');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['platform-sales'], queryFn: () => api.get<Sales>('/api/platform/sales') });
  const [f, setF] = useState({ apiKey: '', productId: '', planName: '', card: true, pix: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) setF((x) => ({ ...x, productId: q.data.productId ?? '', planName: q.data.planName, card: q.data.methods.includes('CARD'), pix: q.data.methods.includes('PIX') }));
  }, [q.data]);
  const save = useMutation({
    mutationFn: (v: { enabled: boolean; regenerateWebhookSecret?: boolean }) =>
      api.put<{ productName: string | null; priceCents: number; intervalMonths: number }>('/api/platform/sales', {
        enabled: v.enabled,
        ...(f.apiKey ? { apiKey: f.apiKey } : {}),
        productId: f.productId,
        planName: f.planName,
        methods: [...(f.card ? ['CARD'] : []), ...(f.pix ? ['PIX'] : [])],
        ...(v.regenerateWebhookSecret ? { regenerateWebhookSecret: true } : {}),
      }),
    onSuccess: (r, v) => {
      setErrors({});
      setF((x) => ({ ...x, apiKey: '' }));
      void qc.invalidateQueries({ queryKey: ['platform-sales'] });
      toast.success(v.enabled ? `Venda online ligada: ${r.productName ?? 'produto'} por ${fmtCents(r.priceCents)}/${interval(r.intervalMonths)}.` : 'Configuração salva.');
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast.error(e);
    },
  });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  return (
    <div className="stack">
      <PageHeader title="Venda online" subtitle="Assinatura do Venceu vendida pela página de vendas, com cobrança recorrente pela AbacatePay." />
      <div className="grid grid-3">
        <div className="card stat"><div className="label">Situação</div><div className="value">{s.available ? 'Vendendo' : 'Desligada'}</div></div>
        <div className="card stat"><div className="label">Preço</div><div className="value">{fmtCents(s.priceCents)}<span className="meta">/{interval(s.intervalMonths)}</span></div></div>
        <div className="card stat"><div className="label">Contas criadas pelo site</div><div className="value">{s.signups.filter((x) => x.status === 'ativo').length}</div></div>
      </div>

      <section className="card card-body stack" style={{ maxWidth: 820 }}>
        <h2>Configuração</h2>
        {!s.available && <Alert kind="info">Com a venda desligada, a página de vendas mostra só o formulário "Quero usar o Venceu".</Alert>}
        <TextField label={s.keyHint ? `Chave da API v2 da AbacatePay (atual: ${s.keyHint})` : 'Chave da API v2 da AbacatePay'} type="password" autoComplete="off"
          value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} error={errors.apiKey}
          placeholder={s.keyHint ? 'Em branco mantém a chave atual' : 'abc_…'}
          hint="Painel da AbacatePay → Integração → Chaves de API. Precisa das permissões de clientes, produtos e assinaturas." />
        <div className="form-grid">
          <TextField label="ID do produto (assinatura)" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })} error={errors.productId}
            hint="Produto com ciclo mensal criado na AbacatePay. O preço vem dele." />
          <TextField label="Nome do plano" value={f.planName} onChange={(e) => setF({ ...f, planName: e.target.value })} error={errors.planName} maxLength={80} />
        </div>
        <div className="row">
          <Switch checked={f.card} onChange={(e) => setF({ ...f, card: e.target.checked })} label="Cartão de crédito (renova sozinho)" />
          <Switch checked={f.pix} onChange={(e) => setF({ ...f, pix: e.target.checked })} label="PIX Automático"
            hint="Só se o PIX Automático estiver habilitado na sua conta AbacatePay." />
        </div>
        <div className="form-actions">
          {s.enabled && <Button variant="ghost" loading={save.isPending} onClick={() => save.mutate({ enabled: false })}>Desligar venda</Button>}
          <Button variant="primary" loading={save.isPending} disabled={!f.productId || (!f.apiKey && !s.keyHint)} onClick={() => save.mutate({ enabled: true })}>
            {s.enabled ? 'Salvar' : 'Ligar venda online'}
          </Button>
        </div>
      </section>

      {s.keyHint && s.webhookSecret && (
        <section className="card card-body stack" style={{ maxWidth: 820 }}>
          <h2>Webhook na AbacatePay</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Em <strong>Integração → Webhooks → Criar</strong>, cole a URL e o segredo e marque os eventos de <strong>assinatura</strong>{" "}
            (concluída, renovada, cancelada). Sem o webhook, o sistema ainda cria a conta de quem pagou (confere a cada poucos minutos),
            mas as <strong>renovações</strong> dependem dele.
          </p>
          <TextField label="URL do webhook" readOnly value={s.webhookUrl} onFocus={(e) => e.currentTarget.select()} />
          <div><CopyButton text={s.webhookUrl} label="Copiar URL" /></div>
          <TextField label="Segredo" readOnly value={s.webhookSecret} onFocus={(e) => e.currentTarget.select()} />
          <div className="row-sm">
            <CopyButton text={s.webhookSecret} label="Copiar segredo" />
            <Button size="sm" variant="ghost" loading={save.isPending} onClick={() => save.mutate({ enabled: s.enabled, regenerateWebhookSecret: true })}>Gerar novo segredo</Button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-header"><h2 style={{ margin: 0 }}>Cadastros pela página de vendas</h2></div>
        {!s.signups.length ? <Empty title="Nenhum cadastro ainda" icon="users" /> : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead><tr><th>Empresa</th><th>Responsável</th><th>Situação</th><th>Data</th></tr></thead>
              <tbody>
                {s.signups.map((x) => (
                  <tr key={x.id}>
                    <td data-label="Empresa">
                      {x.organizationId ? <Link to={`/app/plataforma/organizacoes/${x.organizationId}`}>{x.businessName}</Link> : x.businessName}
                      {x.error && <div className="tiny red">{x.error}</div>}
                    </td>
                    <td data-label="Responsável">{x.ownerName}<div className="tiny muted">{x.email} · {fmtPhone(x.phone)}</div></td>
                    <td data-label="Situação"><span className={`badge ${statusBadge[x.status][1]}`}>{statusBadge[x.status][0]}</span></td>
                    <td data-label="Data" className="num">{fmtDateTime(x.activatedAt ?? x.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
