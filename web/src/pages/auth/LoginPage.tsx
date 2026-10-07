import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, TextField, usePageTitle } from '../../components/ui';
import { AuthShell } from './AuthShell';

export function LoginPage() {
  usePageTitle('Entrar');
  const { user, login, expired } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wanted = (loc.state as { from?: string } | null)?.from;
  // Somente caminhos internos do painel (evita redirecionamento aberto).
  const from = wanted && /^\/app(\/|$)/.test(wanted) ? wanted : '/app';

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      // Se a página lembrada for de outro perfil, o painel redireciona para a área certa.
      nav(from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Entrar no Venceu">
      <form onSubmit={submit} className="stack" noValidate>
        {expired && !error && <Alert kind="warning">Sua sessão expirou. Entre novamente para continuar.</Alert>}
        {error && <Alert>{error}</Alert>}
        <TextField label="E-mail" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <TextField label="Senha" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email || !password}>
          Entrar
        </Button>
        <div className="row between small">
          <Link to="/esqueci-senha">Esqueci minha senha</Link>
          <Link to="/#comecar">Quero usar o Venceu</Link>
        </div>
      </form>
    </AuthShell>
  );
}
