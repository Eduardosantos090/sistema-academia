import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { Alert, Button, ErrorState, Loading, PageHeader, TextField, fieldErrors, useToast, usePageTitle } from '../../components/ui';

interface Server { url: string | null; configured: boolean; keyHint: string | null; instances: number; connected: number }

/** Servidor da Evolution API usado para conectar o WhatsApp das empresas por QR Code. */
export function WhatsAppServerPage() {
  usePageTitle('WhatsApp por QR Code');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['platform-wa-server'], queryFn: () => api.get<Server>('/api/platform/whatsapp-server') });
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data?.url) setUrl(q.data.url);
  }, [q.data?.url]);
  const save = useMutation({
    mutationFn: (v: { url: string | null }) => api.put('/api/platform/whatsapp-server', { url: v.url, ...(apiKey ? { apiKey } : {}) }),
    onSuccess: (_r, v) => {
      setApiKey('');
      setErrors({});
      void qc.invalidateQueries({ queryKey: ['platform-wa-server'] });
      toast.success(v.url ? 'Servidor conectado. As empresas já podem ler o QR Code.' : 'Conexão por QR Code desligada.');
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
      <PageHeader title="WhatsApp por QR Code" subtitle="Servidor da Evolution API que liga o WhatsApp de cada empresa ao Venceu, lendo um QR Code." />
      <div className="grid grid-3">
        <div className="card stat"><div className="label">Situação</div><div className="value">{s.configured ? 'Ativo' : 'Desligado'}</div></div>
        <div className="card stat"><div className="label">Empresas com conexão</div><div className="value">{s.instances}</div></div>
        <div className="card stat"><div className="label">Conectadas agora</div><div className="value">{s.connected}</div></div>
      </div>
      <section className="card card-body stack" style={{ maxWidth: 820 }}>
        <h2>Servidor Evolution API</h2>
        <Alert kind="info">
          Instale a Evolution API (v2) em um servidor próprio (VPS) ou contrate uma hospedada, com endereço <strong>https://</strong>. Informe
          abaixo o endereço e a chave global (<code>AUTHENTICATION_API_KEY</code>). Depois disso, em Configurações → WhatsApp, cada empresa
          vê o botão <strong>Conectar com QR Code</strong>.
        </Alert>
        <TextField label="Endereço do servidor" value={url} onChange={(e) => setUrl(e.target.value)} error={errors.url} placeholder="https://whatsapp.seudominio.com.br" />
        <TextField label={s.keyHint ? `Chave global (atual: ${s.keyHint})` : 'Chave global'} type="password" autoComplete="new-password" spellCheck={false} value={apiKey}
          onChange={(e) => setApiKey(e.target.value)} error={errors.apiKey} placeholder={s.keyHint ? 'Em branco mantém a chave atual' : ''} />
        <div className="form-actions">
          {s.configured && <Button variant="ghost" loading={save.isPending} onClick={() => save.mutate({ url: null })}>Desligar</Button>}
          <Button variant="primary" loading={save.isPending} disabled={!url || (!apiKey && !s.keyHint)} onClick={() => save.mutate({ url })}>Testar e salvar</Button>
        </div>
      </section>
    </div>
  );
}
