import { useState, type FormEvent } from 'react';
import { Button, TextField } from '../../components/ui';

export function PasswordForm({ onSubmit, submitLabel, busy }: { onSubmit: (pw: string) => void; submitLabel: string; busy: boolean }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [touched, setTouched] = useState(false);
  const tooShort = pw.length > 0 && pw.length < 10;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (pw.length >= 10 && pw === pw2) onSubmit(pw);
  };
  return (
    <form onSubmit={submit} className="stack" noValidate>
      <TextField
        label="Nova senha"
        type="password"
        autoComplete="new-password"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        hint="Mínimo de 10 caracteres. Prefira uma frase longa e exclusiva."
        error={touched || tooShort ? (tooShort ? 'A senha deve ter ao menos 10 caracteres.' : undefined) : undefined}
        required
      />
      <TextField
        label="Confirme a nova senha"
        type="password"
        autoComplete="new-password"
        value={pw2}
        onChange={(e) => setPw2(e.target.value)}
        error={mismatch ? 'As senhas não conferem.' : undefined}
        required
      />
      <Button type="submit" variant="primary" loading={busy} disabled={pw.length < 10 || pw !== pw2}>
        {submitLabel}
      </Button>
    </form>
  );
}
