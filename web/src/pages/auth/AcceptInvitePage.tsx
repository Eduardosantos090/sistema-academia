import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Alert, Loading, usePageTitle } from '../../components/ui';
import { AuthShell, readHashToken } from './AuthShell';
import { PasswordForm } from './PasswordForm';

export function AcceptInvitePage() {
  usePageTitle('Aceitar convite');
  const [token] = useState(() => readHashToken());
  const [info, setInfo] = useState<{ email: string; fullName: string } | null>(null);
  const [error, setError] = useState<string | null>(token ? null : 'Convite inválido.');
  const [loading, setLoading] = useState(!!token);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    api
      .post<{ email: string; fullName: string }>('/api/auth/invite/inspect', { token })
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Convite inválido.'))
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async (password: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/invite/accept', { token, password });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível concluir o cadastro.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Aceitar convite">
      {loading ? (
        <Loading />
      ) : done ? (
        <div className="stack">
          <Alert kind="success">Senha definida com sucesso. Agora você já pode entrar.</Alert>
          <Link to="/entrar" className="btn btn-primary">
            Entrar
          </Link>
        </div>
      ) : info ? (
        <div className="stack">
          <p>
            Olá, <strong>{info.fullName}</strong>. Defina uma senha para o acesso <strong>{info.email}</strong>.
          </p>
          {error && <Alert>{error}</Alert>}
          <PasswordForm onSubmit={submit} submitLabel="Definir senha e ativar acesso" busy={busy} />
        </div>
      ) : (
        <div className="stack">
          <Alert>{error}</Alert>
          <p className="muted small">Peça ao responsável pela sua conta o envio de um novo convite.</p>
          <Link to="/entrar">Ir para o login</Link>
        </div>
      )}
    </AuthShell>
  );
}
