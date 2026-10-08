import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { brand } from '../../brand';
import { Alert, Button, Checkbox, SelectField, TextArea, TextField, fieldErrors, usePageTitle } from '../../components/ui';
import { Icon, WhatsAppIcon, type IconName } from '../../components/icons';
import { BrandMark } from '../../layout/AppLayout';
import { fmtCents, segmentLabel } from '../../lib/format';

const FEATURES: { icon: IconName | 'wa'; title: string; text: string }[] = [
  { icon: 'calendarCheck', title: 'Avisos automáticos', text: 'Lembretes antes, no dia e depois do vencimento — no horário que você escolher, sem precisar lembrar de nada.' },
  { icon: 'wa', title: 'WhatsApp e e-mail', text: 'API oficial do WhatsApp, integração com Z-API/Evolution/n8n ou envio em um clique pelo painel. E-mail com descadastro.' },
  { icon: 'bot', title: 'Chatbot inteligente', text: 'Seu cliente consulta vencimentos, recebe o PIX, avisa que pagou e fala com um atendente — 24 horas por dia.' },
  { icon: 'shield', title: 'Mais clientes em dia', text: 'Painel com quem está em atraso, recebido no mês, taxa de adimplência e pagamentos para conferir.' },
  { icon: 'repeat', title: 'Assinaturas recorrentes', text: 'Planos mensais, trimestrais, semestrais ou anuais geram as cobranças sozinhos, todo mês.' },
  { icon: 'users', title: 'Equipe e permissões', text: 'Responsável e atendentes com acessos diferentes, auditoria de tudo e dados isolados por empresa.' },
];

const STEPS = [
  ['Cadastre seus clientes', 'Nome, WhatsApp, e-mail e o plano de cada um. Leva segundos.'],
  ['Defina as regras', 'Quando avisar (ex.: 3 dias antes, no dia e 3 dias depois) e o texto de cada mensagem.'],
  ['O Venceu avisa por você', 'As cobranças são geradas e os lembretes saem automaticamente, no horário comercial.'],
  ['Acompanhe e receba', 'Dê baixa em um clique e o cliente recebe a confirmação de pagamento.'],
];

export interface PublicPlan {
  available: boolean; planName: string; priceCents: number; intervalMonths: number; methods: string[];
}
export const usePublicPlan = () =>
  useQuery({ queryKey: ['public-plan'], queryFn: () => api.get<PublicPlan>('/api/public/plan'), staleTime: 60_000, retry: false });
export const perInterval = (m: number) => (m === 1 ? 'mês' : m === 12 ? 'ano' : `${m} meses`);

const PLAN_ITEMS = [
  'Clientes e cobranças ilimitados',
  'Lembretes automáticos por WhatsApp e e-mail',
  'Assistente virtual (chatbot) com texto, imagem e áudio',
  'Intervalo entre disparos no seu critério',
  'PIX automático com baixa sozinha',
  'Painel de quem recebeu e de quem falta',
  'Equipe com permissões e auditoria',
];

export function LandingPage() {
  usePageTitle('Lembretes de vencimento com automação de chatbot');
  const { user } = useAuth();
  const plan = usePublicPlan().data;
  const price = plan ? `${fmtCents(plan.priceCents).replace(',00', '')}/${perInterval(plan.intervalMonths)}` : null;
  return (
    <div className="landing">
      <header className="l-nav">
        <Link to="/" className="brand" aria-label="Venceu — página inicial">
          <BrandMark />
        </Link>
        <nav aria-label="Navegação do site">
          <a className="l-link" href="#recursos">Recursos</a>
          <a className="l-link" href="#como-funciona">Como funciona</a>
          <a className="l-link" href="#planos">Preço</a>
          {user ? (
            <Link to="/app" className="btn btn-primary">Abrir painel</Link>
          ) : (
            <Link to="/entrar" className="btn">Entrar</Link>
          )}
        </nav>
      </header>

      <main>
        <section className="l-hero" aria-labelledby="hero-title">
          <div>
            <div className="eyebrow">Lembretes de vencimento · WhatsApp · Chatbot</div>
            <h1 id="hero-title" style={{ marginTop: 14 }}>
              Seus clientes pagam em dia. <em>Sem você cobrar.</em>
            </h1>
            <p className="lead">
              O Venceu envia avisos automáticos de vencimento por WhatsApp e e-mail, responde dúvidas com um assistente virtual
              e mostra em tempo real quem está em dia — para academias, escolas, clínicas, estúdios e qualquer negócio com
              mensalidade.
            </p>
            <div className="row">
              {plan?.available ? (
                <Link to="/assinar" className="btn btn-primary btn-lg">
                  Assinar por {price} <Icon name="arrowRight" />
                </Link>
              ) : (
                <a href="#comecar" className="btn btn-primary btn-lg">
                  Quero usar o Venceu <Icon name="arrowRight" />
                </a>
              )}
              <a href="#como-funciona" className="btn btn-lg">Ver como funciona</a>
            </div>
          </div>
          <img className="hero-art" src={brand.icon.src} width={brand.icon.width} height={brand.icon.height} alt="" aria-hidden="true" />
        </section>

        <section className="l-section" id="recursos" aria-labelledby="rec-title">
          <div className="eyebrow">Recursos</div>
          <h2 id="rec-title" style={{ marginTop: 8 }}>Tudo o que você precisa para receber sem dor de cabeça</h2>
          <p className="section-lead">Do lembrete ao recibo: o ciclo completo da cobrança recorrente, automatizado.</p>
          <div className="grid grid-3">
            {FEATURES.map((f) => (
              <article key={f.title} className="card feature">
                <div className="f-icon">{f.icon === 'wa' ? <WhatsAppIcon size={22} /> : <Icon name={f.icon} size={22} />}</div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="l-section" id="como-funciona" aria-labelledby="como-title">
          <div className="grid grid-main" style={{ alignItems: 'center', gap: 40 }}>
            <div>
              <div className="eyebrow">Como funciona</div>
              <h2 id="como-title" style={{ marginTop: 8 }}>Configure uma vez. O Venceu cuida do resto.</h2>
              <p className="section-lead">Funciona para qualquer cobrança recorrente ou avulsa.</p>
              <div className="steps" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                {STEPS.map(([t, d]) => (
                  <div key={t} className="card step">
                    <h3>{t}</h3>
                    <p className="muted" style={{ margin: '6px 0 0' }}>{d}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="phone-mock" aria-label="Exemplo de conversa com o assistente">
              <div className="chat-body wa-demo">
                <div className="bubble out">
                  Olá, Ana! 👋 Passando para lembrar que a Mensalidade Plano Mensal no valor de R$ 129,90 vence em 10/10.
                  {'\n\n'}💠 PIX: financeiro@academia.com.br
                  <span className="meta">09:00 · Venceu</span>
                </div>
                <div className="bubble in">Qual o valor que eu devo?<span className="meta">09:12</span></div>
                <div className="bubble out bot">
                  📋 Seus vencimentos em aberto:{'\n'}• Mensalidade — R$ 129,90 — vence 10/10/2026{'\n\n'}Digite 2 para ver os dados de pagamento.
                  <span className="meta">09:12 · Assistente</span>
                </div>
                <div className="bubble in">Já paguei!<span className="meta">09:30</span></div>
                <div className="bubble out bot">
                  Obrigado! 🙌 Registramos seu aviso de pagamento. Nossa equipe vai conferir e confirmar em breve.
                  <span className="meta">09:30 · Assistente</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="l-section" aria-labelledby="seg-title">
          <h2 id="seg-title">Feito para quem vive de mensalidade</h2>
          <p className="section-lead">Academias são só o começo — o Venceu atende qualquer negócio com vencimentos.</p>
          <div className="segments">
            {Object.entries(segmentLabel).filter(([k]) => k !== 'outro').map(([k, v]) => (
              <span key={k}>{v}</span>
            ))}
          </div>
        </section>

        <section className="l-section" id="planos" aria-labelledby="plan-title">
          <div className="l-pricing">
            <div>
              <div className="eyebrow">Preço</div>
              <h2 id="plan-title" style={{ marginTop: 8 }}>Um plano, tudo incluso</h2>
              <p className="section-lead">
                Sem taxa de adesão, sem fidelidade e sem limite de clientes. Cancele quando quiser — o acesso continua até o fim do
                período pago.
              </p>
            </div>
            <article className="card l-plan" aria-label={`Plano ${plan?.planName ?? 'Venceu Mensal'}`}>
              <div className="l-plan-name">{plan?.planName ?? 'Venceu Mensal'}</div>
              <div className="l-plan-price">
                <span className="num">{fmtCents(plan?.priceCents ?? 5000).replace(',00', '')}</span>
                <span className="muted">/{perInterval(plan?.intervalMonths ?? 1)}</span>
              </div>
              <ul className="l-plan-items">
                {PLAN_ITEMS.map((t) => (
                  <li key={t}><span className="green"><Icon name="checkCircle" size={18} /></span> {t}</li>
                ))}
              </ul>
              {plan?.available ? (
                <>
                  <Link to="/assinar" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }}>
                    Assinar agora <Icon name="arrowRight" />
                  </Link>
                  <p className="tiny muted" style={{ margin: '10px 0 0', textAlign: 'center' }}>
                    Pagamento seguro pela AbacatePay{plan.methods.includes('PIX') ? ' · cartão ou PIX' : ' · cartão de crédito'}. Seu acesso é liberado na hora.
                  </p>
                </>
              ) : (
                <a href="#comecar" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }}>Quero contratar</a>
              )}
            </article>
          </div>
        </section>

        <section className="l-section" id="comecar" aria-labelledby="cta-title">
          <div className="l-cta">
            <div>
              <div className="eyebrow">Comece agora</div>
              <h2 id="cta-title" style={{ marginTop: 8 }}>{plan?.available ? 'Prefere falar com a gente antes?' : 'Quero usar o Venceu na minha empresa'}</h2>
              <p className="section-lead" style={{ marginBottom: 18 }}>
                Envie seus dados e nossa equipe libera o acesso com a configuração inicial pronta: modelos de mensagem, regras
                de lembrete e assistente virtual.
              </p>
              <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {['Sem instalar nada — funciona no navegador e no celular', 'Seus dados isolados e protegidos (LGPD)', 'Suporte para configurar o WhatsApp'].map((t) => (
                  <li key={t} className="row-sm"><span className="green"><Icon name="checkCircle" /></span> {t}</li>
                ))}
              </ul>
            </div>
            <AccessRequestForm />
          </div>
        </section>
      </main>

      <footer className="l-footer">
        <span>© {new Date().getFullYear()} Venceu · {brand.tagline}</span>
        <span>{brand.credit}</span>
      </footer>
    </div>
  );
}

function AccessRequestForm() {
  const [form, setForm] = useState({ name: '', businessName: '', segment: 'academia', email: '', phone: '', message: '', website: '' });
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await api.post('/api/public/access-request', { ...form, phone: form.phone || null, message: form.message || null, consent });
      setDone(true);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError ? err.message : 'Não foi possível enviar.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="card card-glow card-body stack" role="status">
        <div className="empty-icon" style={{ margin: 0 }}><Icon name="checkCircle" size={26} /></div>
        <h3>Pedido recebido! 🎉</h3>
        <p className="muted">Entraremos em contato pelo e-mail ou WhatsApp informado para liberar o seu acesso.</p>
      </div>
    );
  }
  return (
    <form className="card card-body stack" onSubmit={submit} noValidate>
      {error && <Alert>{error}</Alert>}
      <div className="form-grid">
        <TextField label="Seu nome" value={form.name} onChange={set('name')} error={errors.name} required autoComplete="name" />
        <TextField label="Nome da empresa" value={form.businessName} onChange={set('businessName')} error={errors.businessName} required autoComplete="organization" />
        <SelectField label="Segmento" value={form.segment} onChange={set('segment')}>
          {Object.entries(segmentLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </SelectField>
        <TextField label="WhatsApp" value={form.phone} onChange={set('phone')} error={errors.phone} inputMode="tel" placeholder="(11) 90000-0000" autoComplete="tel" />
        <div className="full">
          <TextField label="E-mail" type="email" value={form.email} onChange={set('email')} error={errors.email} required autoComplete="email" />
        </div>
        <div className="full">
          <TextArea label="Quantos clientes você tem? Alguma observação?" value={form.message} onChange={set('message')} error={errors.message} rows={3} />
        </div>
      </div>
      {/* Campo-armadilha para robôs (invisível para pessoas e leitores de tela). */}
      <input type="text" name="website" value={form.website} onChange={set('website')} tabIndex={-1} autoComplete="off" aria-hidden="true" style={{ position: 'absolute', left: -9999, width: 1, height: 1 }} />
      <Checkbox
        checked={consent}
        onChange={(e) => setConsent(e.target.checked)}
        label="Concordo com o uso destes dados apenas para contato sobre o Venceu."
      />
      {errors.consent && <span className="error small red">{errors.consent}</span>}
      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!consent}>
        Solicitar acesso
      </Button>
    </form>
  );
}
