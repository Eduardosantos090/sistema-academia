import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Button, Checkbox, Loading, SelectField, TextField, fieldErrors, usePageTitle } from '../../components/ui';
import { Icon } from '../../components/icons';
import { fmtCents, segmentLabel } from '../../lib/format';
import { AuthShell } from '../auth/AuthShell';
import { perInterval, usePublicPlan } from './LandingPage';

/** "Criar conta": cadastro simples, entra na hora (sem verificação de e-mail). */
export function CreateAccountPage() {
  usePageTitle('Criar conta');
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const plan = usePublicPlan();
  const [form, setForm] = useState({ ownerName: '', businessName: '', segment: 'academia', email: '', phone: '', password: '', website: '' });
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (user) return <Navigate to="/app" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const local: Record<string, string> = {};
    if (form.password.length < 10) local.password = 'A senha deve ter ao menos 10 caracteres.';
    if (!consent) local.consent = 'É preciso aceitar para continuar.';
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      await api.post('/api/public/register', { ...form, consent });
      await refresh();
      nav('/app', { replace: true });
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar a conta.');
      setBusy(false);
    }
  };

  if (plan.isLoading) return <AuthShell title="Criar conta"><Loading /></AuthShell>;
  const p = plan.data;
  if (!p?.available) {
    return (
      <AuthShell title="Criar conta">
        <Alert kind="info">O cadastro online está indisponível no momento.</Alert>
        <Link to="/#comecar" className="btn btn-primary">Falar com a equipe</Link>
      </AuthShell>
    );
  }
  const trial = p.trialDays ?? 0;
  return (
    <AuthShell title="Criar sua conta">
      <div className="signup-plan">
        <div>
          <strong>{trial ? `${trial} dias grátis` : p.planName}</strong>
          <div className="tiny muted">{trial ? `Depois, ${fmtCents(p.priceCents)}/${perInterval(p.intervalMonths)}. Sem fidelidade.` : 'Sem fidelidade · cancele quando quiser'}</div>
        </div>
        {!trial && <div className="num"><strong>{fmtCents(p.priceCents)}</strong><span className="muted small">/{perInterval(p.intervalMonths)}</span></div>}
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <TextField label="Seu nome" value={form.ownerName} onChange={set('ownerName')} error={errors.ownerName} required autoComplete="name" />
        <TextField label="Nome da empresa" value={form.businessName} onChange={set('businessName')} error={errors.businessName} required autoComplete="organization" />
        <SelectField label="Segmento" value={form.segment} onChange={set('segment')}>
          {Object.entries(segmentLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </SelectField>
        <TextField label="WhatsApp" value={form.phone} onChange={set('phone')} error={errors.phone} required inputMode="tel" placeholder="(11) 90000-0000" autoComplete="tel" />
        <TextField label="E-mail (será o seu login)" type="email" value={form.email} onChange={set('email')} error={errors.email} required autoComplete="email" />
        <TextField label="Crie uma senha" type="password" value={form.password} onChange={set('password')} error={errors.password} required autoComplete="new-password" hint="Mínimo de 10 caracteres." />
        <input type="text" name="website" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: -9999, width: 1, height: 1 }} />
        <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)}
          label={<>Li e aceito os <Link to="/termos" target="_blank">Termos de Uso</Link> e a <Link to="/privacidade" target="_blank">Política de Privacidade</Link>.</>} />
        {errors.consent && <span className="small red" role="alert">{errors.consent}</span>}
        <Button type="submit" variant="primary" size="lg" loading={busy}>Criar conta e entrar <Icon name="arrowRight" /></Button>
      </form>
      <p className="small muted" style={{ textAlign: 'center' }}>Já tem conta? <Link to="/entrar">Entrar</Link></p>
    </AuthShell>
  );
}
