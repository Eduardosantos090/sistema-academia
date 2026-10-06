import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Alert, usePageTitle } from '../../components/ui';
import { AuthShell, readHashToken } from './AuthShell';
import { PasswordForm } from './PasswordForm';

export function ResetPasswordPage() {
  usePageTitle('Redefinir senha');
  const [token] = useState(() => readHashToken());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (password: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/password-reset/confirm', { token, password });
      setDone(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível redefinir a senha.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Redefinir senha">
      {!token ? (
        <div className="stack">
          <Alert>Link inválido. Solicite uma nova recuperação de senha.</Alert>
          <Link to="/esqueci-senha">Solicitar novo link</Link>
        </div>
      ) : done ? (
        <div className="stack">
          <Alert kind="success">Senha redefinida. Por segurança, todas as sessões anteriores foram encerradas.</Alert>
          <Link to="/entrar" className="btn btn-primary">
            Entrar
          </Link>
        </div>
      ) : (
        <div className="stack">
          {error && <Alert>{error}</Alert>}
          <PasswordForm onSubmit={submit} submitLabel="Salvar nova senha" busy={busy} />
        </div>
      )}
    </AuthShell>
  );
}
