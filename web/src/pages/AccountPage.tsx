import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Alert, Button, PageHeader, TextField, useToast, usePageTitle } from '../components/ui';
import { roleLabel } from '../lib/format';

export function AccountPage() {
  usePageTitle('Minha conta');
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.fullName ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const saveName = useMutation({
    mutationFn: () => api.patch('/api/me', { fullName: name }),
    onSuccess: () => {
      void refresh();
      toast.success('Nome atualizado.');
    },
    onError: (e) => toast.error(e),
  });
  const change = useMutation({
    mutationFn: () => api.post('/api/auth/password/change', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setNext2('');
      setError(null);
      toast.success('Senha alterada. As outras sessões foram encerradas.');
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Não foi possível alterar.'),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    change.mutate();
  };
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <PageHeader title="Minha conta" subtitle={`${user?.email}${user?.role ? ` · ${roleLabel[user.role]}` : ''}${user?.isPlatformAdmin ? ' · Administração da plataforma' : ''}`} />
      <section className="card card-body stack">
        <h2>Seus dados</h2>
        <TextField label="Nome" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="form-actions"><Button variant="primary" loading={saveName.isPending} disabled={name.trim().length < 2} onClick={() => saveName.mutate()}>Salvar</Button></div>
      </section>
      <form className="card card-body stack" onSubmit={submit} noValidate>
        <h2>Trocar senha</h2>
        {error && <Alert>{error}</Alert>}
        <TextField label="Senha atual" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <TextField label="Nova senha" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} hint="Mínimo de 10 caracteres." />
        <TextField label="Confirme a nova senha" type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)}
          error={next2 && next !== next2 ? 'As senhas não conferem.' : undefined} />
        <div className="form-actions">
          <Button type="submit" variant="primary" loading={change.isPending} disabled={!current || next.length < 10 || next !== next2}>Alterar senha</Button>
        </div>
      </form>
    </div>
  );
}
