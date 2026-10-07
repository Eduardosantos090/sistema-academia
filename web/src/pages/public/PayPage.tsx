import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { Alert, Button, CopyButton, Loading, usePageTitle, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { fmtCents, fmtDate, fmtDateTime } from '../../lib/format';
import { AuthShell } from '../auth/AuthShell';

interface PayData {
  orgName: string;
  description: string;
  amountCents: number;
  dueDate: string;
  status: 'aberta' | 'paga' | 'cancelada';
  paidAt: string | null;
  pix: { brCode: string; image: string | null; expiresAt: string; devMode: boolean } | null;
  unavailable: string | null;
}

/** Página pública de pagamento por PIX (link enviado nos lembretes). */
export function PayPage() {
  usePageTitle('Pagamento');
  const toast = useToast();
  const { token = '' } = useParams();
  const valid = /^[0-9a-f]{64}$/.test(token);
  const q = useQuery({
    queryKey: ['pay', token],
    queryFn: () => api.get<PayData>(`/api/pay/${token}`),
    enabled: valid,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [paid, setPaid] = useState(false);
  const check = useMutation({
    mutationFn: (simulate: boolean) => api.post<{ status: string }>(`/api/pay/${token}/${simulate ? 'simulate' : 'check'}`),
    onSuccess: (r) => {
      if (r.status === 'paga') setPaid(true);
      else toast.info('Ainda não identificamos o pagamento. Pode levar alguns instantes após pagar.');
    },
    onError: (e) => toast.error(e),
  });

  // Confere sozinho a cada 15 s enquanto a página estiver aberta (até 10 min).
  const open = q.data?.status === 'aberta' && !!q.data.pix && !paid;
  useEffect(() => {
    if (!open) return;
    let n = 0;
    const id = setInterval(() => {
      if (++n > 40 || document.hidden) return;
      void api.post<{ status: string }>(`/api/pay/${token}/check`).then((r) => r.status === 'paga' && setPaid(true)).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(id);
  }, [open, token]);

  const d = q.data;
  return (
    <AuthShell title={d ? d.orgName : 'Pagamento'}>
      {!valid ? (
        <Alert>Link de pagamento inválido.</Alert>
      ) : q.isLoading ? (
        <Loading label="Gerando o PIX…" />
      ) : q.error ? (
        <Alert>{q.error instanceof ApiError && q.error.status === 404 ? 'Cobrança não encontrada.' : 'Não foi possível abrir a cobrança. Tente novamente.'}</Alert>
      ) : d ? (
        <div className="stack pay">
          <div className="pay-summary">
            <div className="muted small">{d.description}</div>
            <div className="pay-amount num">{fmtCents(d.amountCents)}</div>
            <div className="muted small">Vencimento: {fmtDate(d.dueDate)}</div>
          </div>
          {paid || d.status === 'paga' ? (
            <Alert kind="success">
              <strong>Pagamento confirmado!</strong> Obrigado. {d.paidAt && !paid ? `Pago em ${fmtDateTime(d.paidAt)}.` : ''}
            </Alert>
          ) : d.status === 'cancelada' ? (
            <Alert kind="info">Esta cobrança foi cancelada. Em caso de dúvida, fale com {d.orgName}.</Alert>
          ) : d.pix ? (
            <>
              {d.pix.devMode && <Alert kind="warning">Modo de teste: este PIX não cobra de verdade.</Alert>}
              {d.pix.image && <img className="pay-qr" src={d.pix.image} alt="QR Code PIX para pagamento" width={240} height={240} />}
              <div className="stack-sm">
                <label className="label" htmlFor="pix-code">PIX copia e cola</label>
                <textarea id="pix-code" className="input pay-code" readOnly value={d.pix.brCode} rows={3} onFocus={(e) => e.currentTarget.select()} />
                <CopyButton text={d.pix.brCode} label="Copiar código PIX" />
              </div>
              <ol className="muted small pay-steps">
                <li>Abra o app do seu banco e escolha <strong>PIX → Copia e cola</strong> (ou leia o QR Code).</li>
                <li>Cole o código e confirme o pagamento.</li>
                <li>A confirmação aparece aqui automaticamente.</li>
              </ol>
              <Button loading={check.isPending && !check.variables} onClick={() => check.mutate(false)}><Icon name="check" /> Já paguei</Button>
              {d.pix.devMode && (
                <Button variant="ghost" loading={check.isPending && !!check.variables} onClick={() => check.mutate(true)}>Simular pagamento (teste)</Button>
              )}
              <p className="tiny muted" style={{ margin: 0 }}>Código válido até {fmtDateTime(d.pix.expiresAt)}. Depois disso, abra este link de novo para gerar outro.</p>
            </>
          ) : (
            <Alert kind="info">{d.unavailable ?? 'Pagamento online indisponível.'}</Alert>
          )}
          <p className="tiny muted" style={{ margin: 0, textAlign: 'center' }}>Pagamento processado pela AbacatePay. Lembretes por Venceu.</p>
        </div>
      ) : null}
    </AuthShell>
  );
}
