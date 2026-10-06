import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Alert, Button, Loading, usePageTitle } from '../../components/ui';
import { AuthShell } from '../auth/AuthShell';

/** Descadastro de e-mails de lembrete (link assinado recebido no e-mail; token no fragmento #). */
export function UnsubscribePage() {
  usePageTitle('Descadastrar e-mails');
  const [token] = useState(() => {
    const m = window.location.hash.match(/t=([0-9a-f-]{36}\.[A-Za-z0-9_-]{32})/);
    if (m) window.history.replaceState(null, '', window.location.pathname);
    return m ? m[1]! : null;
  });
  const [state, setState] = useState<'confirm' | 'busy' | 'done' | 'error'>(token ? 'confirm' : 'error');
  const [org, setOrg] = useState<string | null>(null);
  const [error, setError] = useState('Link de descadastro inválido.');
  const confirm = async () => {
    setState('busy');
    try {
      const r = await api.post<{ organization: string | null }>('/api/public/unsubscribe', { token });
      setOrg(r.organization);
      setState('done');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível concluir.');
      setState('error');
    }
  };
  return (
    <AuthShell title="Parar de receber e-mails">
      {state === 'busy' ? <Loading /> : state === 'done' ? (
        <Alert kind="success">Pronto! Você não receberá mais lembretes por e-mail{org ? ` de ${org}` : ''}.</Alert>
      ) : state === 'error' ? (
        <Alert>{error}</Alert>
      ) : (
        <div className="stack">
          <p>Confirme para deixar de receber os lembretes de vencimento por e-mail.</p>
          <Button variant="primary" onClick={() => void confirm()}>Confirmar descadastro</Button>
        </div>
      )}
    </AuthShell>
  );
}
