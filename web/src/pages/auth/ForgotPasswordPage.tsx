import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Alert, Button, TextField, usePageTitle } from '../../components/ui';
import { AuthShell } from './AuthShell';

export function ForgotPasswordPage() {
  usePageTitle('Recuperar senha');
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>('/api/auth/password-reset/request', { email });
      setDone(r.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar o pedido.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Recuperar senha">
      {done ? (
        <div className="stack">
          <Alert kind="success">{done}</Alert>
          <Link to="/entrar">Voltar para o login</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="stack" noValidate>
          <p className="muted">Informe seu e-mail. Se houver uma conta ativa, enviaremos um link válido por 60 minutos.</p>
          {error && <Alert>{error}</Alert>}
          <TextField label="E-mail" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Button type="submit" variant="primary" loading={busy} disabled={!email}>
            Enviar instruções
          </Button>
          <Link to="/entrar" className="small">
            Voltar para o login
          </Link>
        </form>
      )}
    </AuthShell>
  );
}
