import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { Alert, Button, Checkbox, Loading, SelectField, TextField, fieldErrors, usePageTitle } from '../../components/ui';
import { Icon } from '../../components/icons';
import { fmtCents, segmentLabel } from '../../lib/format';
import { AuthShell } from '../auth/AuthShell';
import { perInterval, usePublicPlan } from './LandingPage';

/** Contratação online: dados da empresa e senha → pagamento na AbacatePay. */
export function SignupPage() {
  usePageTitle('Assinar o Venceu');
  const plan = usePublicPlan();
  const [form, setForm] = useState({ ownerName: '', businessName: '', segment: 'academia', email: '', phone: '', document: '', password: '', password2: '', website: '' });
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const local: Record<string, string> = {};
    if (form.password.length < 10) local.password = 'A senha deve ter ao menos 10 caracteres.';
    else if (form.password !== form.password2) local.password2 = 'As senhas não conferem.';
    if (!consent) local.consent = 'É preciso aceitar para continuar.';
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const { password2: _p2, document, ...rest } = form;
      const r = await api.post<{ url: string; token: string }>('/api/public/signup', { ...rest, document: document || null, consent });
      try {
        sessionStorage.setItem('venceu-signup', r.token);
      } catch {
        /* armazenamento indisponível: o link de retorno já traz o token */
      }
      window.location.assign(r.url);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : 'Não foi possível continuar.');
      setBusy(false);
    }
  };

  const linkUrl = plan.data?.mode === 'link' ? plan.data.checkoutUrl : null;
  useEffect(() => {
    if (linkUrl) window.location.replace(linkUrl);
  }, [linkUrl]);
  if (plan.isLoading || linkUrl) return <AuthShell title="Assinar o Venceu"><Loading label="Abrindo o pagamento…" /></AuthShell>;
  const p = plan.data;
  if (!p?.available) {
    return (
      <AuthShell title="Assinar o Venceu">
        <Alert kind="info">A contratação online está indisponível no momento.</Alert>
        <Link to="/#comecar" className="btn btn-primary">Falar com a equipe</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Assinar o Venceu">
      <div className="signup-plan">
        <div>
          <strong>{p.planName}</strong>
          <div className="tiny muted">Sem fidelidade · cancele quando quiser</div>
        </div>
        <div className="num"><strong>{fmtCents(p.priceCents)}</strong><span className="muted small">/{perInterval(p.intervalMonths)}</span></div>
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <TextField label="Seu nome" value={form.ownerName} onChange={set('ownerName')} error={errors.ownerName} required autoComplete="name" />
        <TextField label="Nome da empresa" value={form.businessName} onChange={set('businessName')} error={errors.businessName} required autoComplete="organization" />
        <SelectField label="Segmento" value={form.segment} onChange={set('segment')}>
          {Object.entries(segmentLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </SelectField>
        <TextField label="E-mail (será o seu login)" type="email" value={form.email} onChange={set('email')} error={errors.email} required autoComplete="email" />
        <TextField label="WhatsApp" value={form.phone} onChange={set('phone')} error={errors.phone} required inputMode="tel" placeholder="(11) 90000-0000" autoComplete="tel" />
        <TextField label="CPF ou CNPJ (opcional)" value={form.document} onChange={set('document')} error={errors.document} inputMode="numeric" />
        <TextField label="Crie uma senha" type="password" value={form.password} onChange={set('password')} error={errors.password} required autoComplete="new-password" hint="Mínimo de 10 caracteres." />
        <TextField label="Repita a senha" type="password" value={form.password2} onChange={set('password2')} error={errors.password2} required autoComplete="new-password" />
        <input type="text" name="website" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: -9999, width: 1, height: 1 }} />
        <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)}
          label="Concordo com a cobrança recorrente e com o uso dos meus dados para criar e manter a minha conta (LGPD)." />
        {errors.consent && <span className="small red" role="alert">{errors.consent}</span>}
        <Button type="submit" variant="primary" loading={busy}>Ir para o pagamento <Icon name="arrowRight" /></Button>
        <p className="tiny muted" style={{ margin: 0, textAlign: 'center' }}>
          Você será levado ao pagamento seguro da AbacatePay. Assim que o pagamento for confirmado, sua conta é criada e você entra com o e-mail e a senha acima.
        </p>
      </form>
      <p className="small muted" style={{ textAlign: 'center' }}>Já tem conta? <Link to="/entrar">Entrar</Link></p>
    </AuthShell>
  );
}

/** Volta do pagamento: espera a confirmação e libera o acesso. */
export function SignupDonePage() {
  usePageTitle('Assinatura');
  const [params] = useSearchParams();
  const [token] = useState(() => {
    const t = params.get('t');
    if (t && /^[0-9a-f]{64}$/.test(t)) return t;
    try {
      return sessionStorage.getItem('venceu-signup');
    } catch {
      return null;
    }
  });
  const [s, setS] = useState<{ status: string; email: string; businessName: string; checkoutUrl: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (!token) return;
    let stop = false;
    const tick = async (n: number) => {
      try {
        const r = n % 2 === 0
          ? await api.post<{ status: string }>(`/api/public/signup/${token}/check`).then(() => api.get<NonNullable<typeof s>>(`/api/public/signup/${token}`))
          : await api.get<NonNullable<typeof s>>(`/api/public/signup/${token}`);
        if (stop) return;
        setS(r);
        if (r.status === 'pendente' && n < 40) setTimeout(() => void tick(n + 1), 4000);
        setTries(n);
      } catch {
        if (!stop) setFailed(true);
      }
    };
    void tick(0);
    return () => {
      stop = true;
    };
  }, [token]);

  return (
    <AuthShell title="Sua assinatura">
      {!token || failed ? (
        <Alert>Não encontramos o seu cadastro. Se você já pagou, entre com o seu e-mail e senha, ou fale com o suporte.</Alert>
      ) : !s ? (
        <Loading label="Confirmando o pagamento…" />
      ) : s.status === 'ativo' ? (
        <div className="stack">
          <Alert kind="success"><strong>Pagamento confirmado! 🎉</strong> A conta da {s.businessName} está pronta.</Alert>
          <p>Entre com <strong>{s.email}</strong> e a senha que você criou. A configuração inicial (modelos de mensagem, regras de lembrete e assistente) já está pronta.</p>
          <Link to="/entrar" className="btn btn-primary btn-lg">Entrar no Venceu <Icon name="arrowRight" /></Link>
        </div>
      ) : s.status === 'pendente' ? (
        <div className="stack">
          <Loading label="Aguardando a confirmação do pagamento…" />
          <p className="small muted" style={{ textAlign: 'center' }}>
            {tries >= 40
              ? 'Ainda não recebemos a confirmação. Se você pagou, ela pode levar alguns minutos — volte a esta página ou entre depois com seu e-mail e senha.'
              : 'Isso leva só alguns segundos depois do pagamento. Não feche esta página.'}
          </p>
          {s.checkoutUrl && <a className="btn" href={s.checkoutUrl}>Voltar ao pagamento</a>}
        </div>
      ) : (
        <div className="stack">
          <Alert kind="warning">Este cadastro não foi concluído. Você pode começar de novo.</Alert>
          <Link to="/assinar" className="btn btn-primary">Assinar de novo</Link>
        </div>
      )}
    </AuthShell>
  );
}
