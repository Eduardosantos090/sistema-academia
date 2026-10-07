import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import type { InviteResult, TeamUser, WhatsAppMode } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  Alert, Button, ConfirmDialog, CopyButton, Empty, ErrorState, Loading, Modal, PageHeader, SecretLink, SelectField, Switch, Tabs,
  TextArea, TextField, fieldErrors, useToast, usePageTitle,
} from '../../components/ui';
import { Icon, WhatsAppIcon } from '../../components/icons';
import { fmtDateTime, fmtDocument, fmtPhone, roleLabel, segmentLabel } from '../../lib/format';

interface Settings {
  organization: {
    id: string; name: string; slug: string; segment: string; contactEmail: string | null; contactPhone: string | null; document: string | null;
    pixKey: string | null; paymentInstructions: string | null; timezone: string; sendHour: number; notifyOnPayment: boolean;
    botEnabled: boolean; botGreeting: string | null; sendDelaySeconds: number;
  };
  channels: {
    whatsappMode: WhatsAppMode; whatsappAutomatic: boolean; phoneNumberId: string | null; hasAccessToken: boolean; hasAppSecret: boolean;
    webhookUrl: string | null; hasWebhookSecret: boolean; emailEnabled: boolean; emailAvailable: boolean; emailReplyTo: string | null;
    smtp: { host: string; port: number; user: string; fromName: string | null } | null;
    platformMailMode: 'smtp' | 'manual' | 'dev'; verifyToken?: string | null; cloudWebhookUrl?: string; inboundWebhookUrl?: string;
  };
}

type Tab = 'empresa' | 'cobranca' | 'whatsapp' | 'email' | 'equipe';

export function SettingsPage() {
  const { isOwner } = useAuth();
  usePageTitle(isOwner ? 'Configurações' : 'Empresa');
  const [tab, setTab] = useState<Tab>('empresa');
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'empresa', label: 'Empresa' },
    { id: 'cobranca', label: 'Cobrança e assistente' },
    ...(isOwner
      ? [
          { id: 'whatsapp' as const, label: 'WhatsApp' },
          { id: 'email' as const, label: 'E-mail' },
          { id: 'equipe' as const, label: 'Equipe' },
        ]
      : []),
  ];
  return (
    <div>
      <PageHeader title={isOwner ? 'Configurações' : 'Empresa'} subtitle={q.data.organization.name} />
      <Tabs<Tab> label="Configurações" value={tab} onChange={setTab} tabs={tabs} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'empresa' && <CompanyTab s={q.data} canEdit={isOwner} />}
        {tab === 'cobranca' && <BillingTab s={q.data} canEdit={isOwner} />}
        {tab === 'whatsapp' && isOwner && <WhatsAppTab s={q.data} />}
        {tab === 'email' && isOwner && <EmailTab s={q.data} />}
        {tab === 'equipe' && isOwner && <TeamTab />}
      </div>
    </div>
  );
}

function useSaveOrg() {
  const qc = useQueryClient();
  const toast = useToast();
  const { refresh } = useAuth();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch('/api/settings/organization', body),
    onSuccess: () => {
      setErrors({});
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void refresh();
      toast.success('Configurações salvas.');
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast.error(e);
    },
  });
  return { m, errors };
}

function CompanyTab({ s, canEdit }: { s: Settings; canEdit: boolean }) {
  const o = s.organization;
  const { m, errors } = useSaveOrg();
  const [f, setF] = useState({
    name: o.name, segment: o.segment, contactEmail: o.contactEmail ?? '', contactPhone: o.contactPhone ? fmtPhone(o.contactPhone) : '', document: o.document ? fmtDocument(o.document) : '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <form className="card card-body stack" style={{ maxWidth: 760 }} onSubmit={(e) => {
      e.preventDefault();
      m.mutate({ name: f.name, segment: f.segment, contactEmail: f.contactEmail || null, contactPhone: f.contactPhone || null, document: f.document || null });
    }}>
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <div className="form-grid">
          <TextField label="Nome da empresa" value={f.name} onChange={set('name')} error={errors.name} />
          <SelectField label="Segmento" value={f.segment} onChange={set('segment')}>
            {Object.entries(segmentLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </SelectField>
          <TextField label="E-mail de contato" value={f.contactEmail} onChange={set('contactEmail')} error={errors.contactEmail} hint="Usado como resposta dos e-mails enviados aos clientes." />
          <TextField label="Telefone / WhatsApp da empresa" value={f.contactPhone} onChange={set('contactPhone')} error={errors.contactPhone} />
          <TextField label="CNPJ ou CPF" value={f.document} onChange={set('document')} error={errors.document} />
        </div>
      </fieldset>
      {canEdit && <div className="form-actions"><Button type="submit" variant="primary" loading={m.isPending}>Salvar</Button></div>}
    </form>
  );
}

function BillingTab({ s, canEdit }: { s: Settings; canEdit: boolean }) {
  const o = s.organization;
  const { m, errors } = useSaveOrg();
  const [f, setF] = useState({
    pixKey: o.pixKey ?? '', paymentInstructions: o.paymentInstructions ?? '', sendHour: String(o.sendHour), notifyOnPayment: o.notifyOnPayment,
    botEnabled: o.botEnabled, botGreeting: o.botGreeting ?? '', timezone: o.timezone,
    delayValue: String(o.sendDelaySeconds % 60 === 0 && o.sendDelaySeconds >= 60 ? o.sendDelaySeconds / 60 : o.sendDelaySeconds),
    delayUnit: o.sendDelaySeconds % 60 === 0 && o.sendDelaySeconds >= 60 ? 'min' : 's',
  });
  const delaySeconds = Math.min(3600, Math.max(0, Math.round((Number(f.delayValue.replace(',', '.')) || 0) * (f.delayUnit === 'min' ? 60 : 1))));
  return (
    <form className="stack" style={{ maxWidth: 820 }} onSubmit={(e) => {
      e.preventDefault();
      m.mutate({
        pixKey: f.pixKey || null, paymentInstructions: f.paymentInstructions || null, sendHour: Number(f.sendHour), notifyOnPayment: f.notifyOnPayment,
        botEnabled: f.botEnabled, botGreeting: f.botGreeting || null, timezone: f.timezone, sendDelaySeconds: delaySeconds,
      });
    }}>
      <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <section className="card card-body stack">
          <h2>Dados de pagamento</h2>
          <p className="muted small" style={{ margin: 0 }}>Aparecem nos lembretes ({'{{instrucoes_pagamento}}'}) e quando o cliente pede pelo assistente.</p>
          <TextField label="Chave PIX" value={f.pixKey} onChange={(e) => setF({ ...f, pixKey: e.target.value })} error={errors.pixKey} placeholder="CNPJ, e-mail, telefone ou chave aleatória" />
          <TextArea label="Instruções de pagamento" value={f.paymentInstructions} onChange={(e) => setF({ ...f, paymentInstructions: e.target.value })} rows={3} maxLength={1000}
            error={errors.paymentInstructions} placeholder="Ex.: Também aceitamos cartão na recepção. Envie o comprovante por aqui." />
        </section>
        <section className="card card-body stack">
          <h2>Envio automático</h2>
          <div className="form-grid">
            <SelectField label="Horário de envio dos lembretes" value={f.sendHour} onChange={(e) => setF({ ...f, sendHour: e.target.value })}
              hint="Os lembretes do dia saem a partir deste horário (nunca depois das 21h).">
              {Array.from({ length: 15 }, (_, i) => i + 6).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </SelectField>
            <SelectField label="Fuso horário" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })}>
              {['America/Sao_Paulo', 'America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Fortaleza', 'America/Recife', 'America/Bahia',
                'America/Porto_Velho', 'America/Boa_Vista', 'America/Rio_Branco', 'America/Noronha'].map((t) => <option key={t} value={t}>{t.replace('America/', '').replace('_', ' ')}</option>)}
            </SelectField>
          </div>
          <div className="form-grid">
            <TextField label="Intervalo entre mensagens" type="number" min={0} step="any" value={f.delayValue}
              onChange={(e) => setF({ ...f, delayValue: e.target.value })}
              hint={delaySeconds ? `Uma mensagem a cada ${delaySeconds >= 60 && delaySeconds % 60 === 0 ? `${delaySeconds / 60} min` : `${delaySeconds} s`} — reduz o risco de bloqueio do WhatsApp. Máximo 60 min.` : 'Sem intervalo: envia tudo de uma vez.'} />
            <SelectField label="Unidade" value={f.delayUnit} onChange={(e) => setF({ ...f, delayUnit: e.target.value })}>
              <option value="s">segundos</option>
              <option value="min">minutos</option>
            </SelectField>
          </div>
          <Switch checked={f.notifyOnPayment} onChange={(e) => setF({ ...f, notifyOnPayment: e.target.checked })} label="Enviar confirmação ao registrar um pagamento" />
        </section>
        <section className="card card-body stack">
          <h2>Assistente virtual</h2>
          <Switch checked={f.botEnabled} onChange={(e) => setF({ ...f, botEnabled: e.target.checked })} label="Responder automaticamente as mensagens recebidas no WhatsApp"
            hint="Desligado: as mensagens chegam no Atendimento para a equipe responder." />
          <TextArea label="Saudação (opcional)" value={f.botGreeting} onChange={(e) => setF({ ...f, botGreeting: e.target.value })} rows={2} maxLength={500}
            error={errors.botGreeting} placeholder="Olá, {{primeiro_nome}}! 💪 Aqui é o assistente da {{empresa}}." hint="Mostrada antes do menu. Aceita {{primeiro_nome}} e {{empresa}}." />
        </section>
      </fieldset>
      {canEdit && <div className="form-actions"><Button type="submit" variant="primary" loading={m.isPending}>Salvar</Button></div>}
    </form>
  );
}

function WhatsAppTab({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const c = s.channels;
  const [mode, setMode] = useState<WhatsAppMode>(c.whatsappMode);
  const [phoneNumberId, setPhoneNumberId] = useState(c.phoneNumberId ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [webhookUrl, setWebhookUrl] = useState(c.webhookUrl ?? '');
  const [secret, setSecret] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => setMode(c.whatsappMode), [c.whatsappMode]);
  const save = useMutation({
    mutationFn: (regenerate: boolean) =>
      api.put<{ webhookSecret: string | null }>('/api/settings/whatsapp', {
        mode, phoneNumberId: phoneNumberId || null, accessToken: accessToken || undefined, appSecret: appSecret || undefined,
        webhookUrl: webhookUrl || null, regenerateWebhookSecret: regenerate,
      }),
    onSuccess: (r) => {
      setErrors({});
      setAccessToken('');
      setAppSecret('');
      if (r.webhookSecret) setSecret(r.webhookSecret);
      void qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Integração salva.');
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast.error(e);
    },
  });
  const test = useMutation({
    mutationFn: () => api.post('/api/settings/whatsapp/test', { to: testTo }),
    onSuccess: () => toast.success('Mensagem de teste enviada.'),
    onError: (e) => toast.error(e),
  });
  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <div className="card card-body row">
        <span style={{ color: 'var(--whatsapp)' }}><WhatsAppIcon size={28} /></span>
        <div style={{ flex: 1 }}>
          <strong>Situação: {c.whatsappAutomatic ? 'envio automático ativo' : 'envio manual (link clique-para-enviar)'}</strong>
          <div className="muted small">
            {c.whatsappAutomatic ? 'Lembretes e respostas do assistente saem sozinhos.' : 'Os lembretes ficam prontos em Mensagens para a equipe enviar com um clique.'}
          </div>
        </div>
        <span className={`badge ${c.whatsappAutomatic ? 'badge-success' : 'badge-warning'}`}>{c.whatsappAutomatic ? 'Automático' : 'Manual'}</span>
      </div>

      <div className="radio-cards">
        {([
          ['manual', 'Manual (sem custo)', 'Você envia pelo seu WhatsApp com um clique. Sem assistente automático.'],
          ['cloud_api', 'API oficial da Meta', 'WhatsApp Business Cloud API: envio e assistente 100% automáticos.'],
          ['webhook', 'Integração via webhook', 'Z-API, Evolution API, n8n, Make… o Venceu chama sua URL.'],
        ] as const).map(([k, t, d]) => (
          <label key={k} className="radio-card">
            <input type="radio" name="wamode" checked={mode === k} onChange={() => setMode(k)} />
            <span><strong>{t}</strong><span className="muted small" style={{ display: 'block' }}>{d}</span></span>
          </label>
        ))}
      </div>

      {mode === 'cloud_api' && (
        <section className="card card-body stack">
          <h2>WhatsApp Cloud API (Meta)</h2>
          <ol className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>No <strong>Meta for Developers</strong>, crie um app do tipo Business e adicione o produto WhatsApp.</li>
            <li>Copie o <strong>ID do número de telefone</strong> e gere um <strong>token de acesso permanente</strong> (usuário do sistema).</li>
            <li>Em Configurações do app → Básico, copie a <strong>Chave secreta do app</strong> (App Secret).</li>
            <li>Em WhatsApp → Configuração, cadastre a URL de callback e o token de verificação abaixo e assine o campo <em>messages</em>.</li>
            <li>Para lembretes, cadastre modelos de mensagem na Meta e informe o nome em cada modelo do Venceu.</li>
          </ol>
          <div className="form-grid">
            <TextField label="ID do número de telefone" value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} error={errors.phoneNumberId} inputMode="numeric" />
            <TextField label="Token de acesso" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} autoComplete="off"
              placeholder={c.hasAccessToken ? '•••••••• (configurado — deixe vazio para manter)' : ''} />
            <TextField label="App Secret" type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} autoComplete="off"
              placeholder={c.hasAppSecret ? '•••••••• (configurado — deixe vazio para manter)' : ''} hint="Usado para validar a assinatura das mensagens recebidas." />
          </div>
          {c.cloudWebhookUrl && (
            <div className="stack-sm">
              <span className="small"><strong>URL de callback</strong></span>
              <div className="row-sm"><code className="code-box mono" style={{ flex: 1 }}>{c.cloudWebhookUrl}</code><CopyButton text={c.cloudWebhookUrl} /></div>
              {c.verifyToken && (
                <>
                  <span className="small"><strong>Token de verificação</strong></span>
                  <div className="row-sm"><code className="code-box mono" style={{ flex: 1 }}>{c.verifyToken}</code><CopyButton text={c.verifyToken} /></div>
                </>
              )}
              {!c.verifyToken && <span className="muted small">Salve a integração para gerar o token de verificação.</span>}
            </div>
          )}
        </section>
      )}

      {mode === 'webhook' && (
        <section className="card card-body stack">
          <h2>Integração via webhook</h2>
          <p className="muted small" style={{ margin: 0 }}>
            <strong>Envio:</strong> o Venceu faz <code>POST</code> na sua URL com <code>{'{ event, organization, messageId, to, text }'}</code> e os cabeçalhos{' '}
            <code>X-Venceu-Timestamp</code> e <code>X-Venceu-Signature</code> (HMAC-SHA256 de “timestamp.corpo” com o segredo). Responda 2xx.
          </p>
          <TextField label="URL de envio (https)" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} error={errors.webhookUrl} placeholder="https://sua-automacao.com/webhook/venceu" />
          {c.inboundWebhookUrl && (
            <div className="stack-sm">
              <p className="muted small" style={{ margin: 0 }}>
                <strong>Recebimento (assistente):</strong> envie as mensagens recebidas para a URL abaixo com <code>{'{ from, text, id }'}</code>, assinadas do mesmo jeito.
                As respostas do assistente voltam no campo <code>replies</code>.
              </p>
              <div className="row-sm"><code className="code-box mono" style={{ flex: 1 }}>{c.inboundWebhookUrl}</code><CopyButton text={c.inboundWebhookUrl} /></div>
            </div>
          )}
          {secret ? (
            <Alert kind="warning">
              <div className="stack-sm">
                <span>Segredo do webhook — copie agora, ele não será exibido de novo:</span>
                <code className="mono">{secret}</code>
                <div><CopyButton text={secret} label="Copiar segredo" /></div>
              </div>
            </Alert>
          ) : (
            c.hasWebhookSecret && <Button onClick={() => save.mutate(true)} loading={save.isPending}><Icon name="key" /> Gerar novo segredo</Button>
          )}
        </section>
      )}

      <div className="form-actions">
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(false)}>Salvar integração</Button>
      </div>

      {c.whatsappAutomatic && (
        <section className="card card-body stack">
          <h2>Testar envio</h2>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <TextField label="Enviar mensagem de teste para" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="(11) 90000-0000" inputMode="tel" />
            </div>
            <Button loading={test.isPending} disabled={!testTo} onClick={() => test.mutate()}><Icon name="send" /> Enviar teste</Button>
          </div>
        </section>
      )}
    </div>
  );
}

const SMTP_PRESETS = [
  { id: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 465, domains: ['gmail.com', 'googlemail.com'],
    help: 'Ative a verificação em duas etapas na Conta Google e crie uma "senha de app" em myaccount.google.com/apppasswords.' },
  { id: 'outlook', label: 'Outlook / Hotmail', host: 'smtp-mail.outlook.com', port: 587, domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    help: 'Ative a verificação em duas etapas na conta Microsoft e crie uma "senha de app" em account.microsoft.com/security.' },
  { id: 'icloud', label: 'iCloud', host: 'smtp.mail.me.com', port: 587, domains: ['icloud.com', 'me.com', 'mac.com'],
    help: 'Crie uma "senha de app" em appleid.apple.com → Iniciar sessão e segurança → Senhas de app.' },
  { id: 'yahoo', label: 'Yahoo', host: 'smtp.mail.yahoo.com', port: 465, domains: ['yahoo.com', 'yahoo.com.br'],
    help: 'Gere uma "senha de app" em login.yahoo.com → Segurança da conta.' },
  { id: 'hostinger', label: 'Hostinger', host: 'smtp.hostinger.com', port: 465, domains: [], help: 'Use o e-mail e a senha da caixa criada no painel da Hostinger.' },
  { id: 'locaweb', label: 'Locaweb', host: 'email-ssl.com.br', port: 465, domains: [], help: 'Use o e-mail e a senha da caixa criada no painel da Locaweb.' },
  { id: 'zoho', label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, domains: ['zohomail.com'], help: 'Use uma senha específica de aplicativo do Zoho.' },
  { id: 'outro', label: 'Outro provedor', host: '', port: 465, domains: [], help: 'Informe o servidor SMTP e a porta indicados pelo seu provedor de e-mail.' },
] as const;
type PresetId = (typeof SMTP_PRESETS)[number]['id'];

function presetFor(host: string): PresetId {
  return SMTP_PRESETS.find((p) => p.host && p.host === host)?.id ?? 'outro';
}

function EmailTab({ s }: { s: Settings }) {
  const qc = useQueryClient();
  const toast = useToast();
  const c = s.channels;
  const [enabled, setEnabled] = useState(c.emailEnabled);
  const [replyTo, setReplyTo] = useState(c.emailReplyTo ?? '');
  const [own, setOwn] = useState(!!c.smtp);
  const [preset, setPreset] = useState<PresetId>(c.smtp ? presetFor(c.smtp.host) : 'gmail');
  const [user, setUser] = useState(c.smtp?.user ?? '');
  const [password, setPassword] = useState('');
  const [host, setHost] = useState(c.smtp?.host ?? 'smtp.gmail.com');
  const [port, setPort] = useState(c.smtp?.port ?? 465);
  const [fromName, setFromName] = useState(c.smtp?.fromName ?? s.organization.name);
  const [testTo, setTestTo] = useState(s.organization.contactEmail ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const p = SMTP_PRESETS.find((x) => x.id === preset)!;

  const pickPreset = (id: PresetId) => {
    setPreset(id);
    const np = SMTP_PRESETS.find((x) => x.id === id)!;
    if (np.host) { setHost(np.host); setPort(np.port); }
  };
  const onUser = (v: string) => {
    setUser(v);
    const domain = v.split('@')[1]?.toLowerCase();
    const match = SMTP_PRESETS.find((x) => (x.domains as readonly string[]).includes(domain ?? ''));
    if (match && match.id !== preset) pickPreset(match.id);
  };

  const m = useMutation({
    mutationFn: () =>
      api.put('/api/settings/email', {
        enabled,
        replyTo: replyTo || null,
        smtp: own ? { host, port, user, password: password || undefined, fromName: fromName || null } : null,
      }),
    onSuccess: () => {
      setErrors({});
      setPassword('');
      void qc.invalidateQueries({ queryKey: ['settings'] });
      toast.success(own ? 'Conta de e-mail conectada. Faça um teste de envio.' : 'Configuração de e-mail salva.');
    },
    onError: (e) => {
      setErrors(Object.fromEntries(Object.entries(fieldErrors(e)).map(([k, v]) => [k.replace(/^smtp\./, ''), v])));
      toast.error(e);
    },
  });
  const test = useMutation({
    mutationFn: () => api.post('/api/settings/email/test', { to: testTo }),
    onSuccess: () => toast.success(`E-mail de teste enviado para ${testTo}. Confira a caixa de entrada (e o spam).`),
    onError: (e) => toast.error(e),
  });

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <section className="card card-body stack">
        <h2>Lembretes por e-mail</h2>
        {!c.smtp && c.platformMailMode === 'manual' && (
          <Alert kind="warning">Conecte o e-mail da sua empresa abaixo para os lembretes por e-mail serem enviados automaticamente.</Alert>
        )}
        <Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} label="Enviar lembretes por e-mail (conforme as regras)" />
        <TextField label="Responder para" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder={c.smtp?.user ?? s.organization.contactEmail ?? 'financeiro@suaempresa.com.br'}
          hint="Quando o cliente responder o e-mail, a resposta vai para este endereço." />
        <p className="muted small" style={{ margin: 0 }}>Todo e-mail inclui um link de descadastro (exigência de boas práticas e da LGPD).</p>
      </section>

      <section className="card card-body stack">
        <h2>E-mail da sua empresa</h2>
        <Switch checked={own} onChange={(e) => setOwn(e.target.checked)} label="Enviar os lembretes pelo meu próprio e-mail"
          hint="Seus clientes recebem as mensagens do endereço da sua empresa, e não de um remetente genérico." />
        {own && (
          <>
            <TextField label="Seu e-mail" type="email" value={user} onChange={(e) => onUser(e.target.value)} error={errors.user} placeholder="financeiro@suaempresa.com.br" autoComplete="off" />
            <SelectField label="Provedor" value={preset} onChange={(e) => pickPreset(e.target.value as PresetId)}>
              {SMTP_PRESETS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </SelectField>
            <Alert kind="info">{p.help}</Alert>
            <TextField label={preset === 'hostinger' || preset === 'locaweb' || preset === 'outro' ? 'Senha do e-mail' : 'Senha de app'} type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} error={errors.password} autoComplete="new-password"
              placeholder={c.smtp ? '•••••••• (em branco mantém a senha salva)' : ''} hint="Fica guardada criptografada e nunca é exibida novamente." />
            {preset === 'outro' && (
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 2, minWidth: 200 }}>
                  <TextField label="Servidor SMTP" value={host} onChange={(e) => setHost(e.target.value)} error={errors.host} placeholder="smtp.seuprovedor.com.br" />
                </div>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <SelectField label="Porta" value={String(port)} onChange={(e) => setPort(Number(e.target.value))} error={errors.port}>
                    <option value="465">465 (SSL)</option>
                    <option value="587">587 (STARTTLS)</option>
                    <option value="2525">2525</option>
                  </SelectField>
                </div>
              </div>
            )}
            <TextField label="Nome do remetente" value={fromName} onChange={(e) => setFromName(e.target.value)} error={errors.fromName} maxLength={80}
              hint="Como aparece na caixa de entrada do cliente." />
          </>
        )}
        <div className="form-actions"><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Salvar</Button></div>
      </section>

      {c.smtp && (
        <section className="card card-body stack">
          <h2>Testar envio</h2>
          <p className="muted small" style={{ margin: 0 }}>Conectado como <strong>{c.smtp.user}</strong>.</p>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <TextField label="Enviar e-mail de teste para" type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="voce@exemplo.com" />
            </div>
            <Button loading={test.isPending} disabled={!testTo} onClick={() => test.mutate()}><Icon name="send" /> Enviar teste</Button>
          </div>
        </section>
      )}
    </div>
  );
}

const accessLabel = { ativo: ['Ativo', 'badge-success'], convite_pendente: ['Convite pendente', 'badge-warning'], convite_expirado: ['Convite expirado', 'badge-danger'], desativado: ['Desativado', ''] } as const;

function TeamTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['team'], queryFn: () => api.get<{ items: TeamUser[]; mailMode: string }>('/api/team') });
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ link: string; hours?: number; kind: 'convite' | 'redefinição' } | null>(null);
  const [toggle, setToggle] = useState<TeamUser | null>(null);
  const act = useMutation({
    mutationFn: ({ u, action }: { u: TeamUser; action: 'invite' | 'reset-link' }) => api.post<InviteResult>(`/api/team/${u.id}/${action}`),
    onSuccess: (r) => {
      if (r.inviteLink) setLink({ link: r.inviteLink, hours: r.validHours, kind: 'convite' });
      else if (r.resetLink) setLink({ link: r.resetLink, hours: r.validHours, kind: 'redefinição' });
      else toast.success('Convite enviado por e-mail.');
      void qc.invalidateQueries({ queryKey: ['team'] });
    },
    onError: (e) => toast.error(e),
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/api/team/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['team'] });
      setToggle(null);
    },
    onError: (e) => {
      toast.error(e);
      setToggle(null);
    },
  });
  if (q.isLoading) return <Loading />;
  return (
    <div className="stack" style={{ maxWidth: 980 }}>
      <div className="row between">
        <p className="muted small" style={{ margin: 0 }}><strong>Responsável</strong>: acesso total. <strong>Equipe</strong>: clientes, cobranças, mensagens e atendimento.</p>
        <Button variant="primary" onClick={() => setInviting(true)}><Icon name="plus" /> Convidar pessoa</Button>
      </div>
      {link && <div className="card card-body"><SecretLink link={link.link} hours={link.hours} kind={link.kind} /></div>}
      <div className="card">
        {!q.data?.items.length ? <Empty title="Sem usuários" /> : (
          <div className="table-wrap">
            <table className="table responsive">
              <thead><tr><th>Nome</th><th>Perfil</th><th>Acesso</th><th>Último acesso</th><th className="actions">Ações</th></tr></thead>
              <tbody>
                {q.data.items.map((u) => (
                  <tr key={u.id}>
                    <td data-label="Nome"><strong>{u.fullName}</strong><div className="tiny muted">{u.email}</div></td>
                    <td data-label="Perfil">
                      {u.id === user?.id ? roleLabel[u.role] : (
                        <select className="select" style={{ minHeight: 32, padding: '4px 8px', width: 'auto' }} value={u.role} aria-label={`Perfil de ${u.fullName}`}
                          onChange={(e) => patch.mutate({ id: u.id, body: { role: e.target.value } })}>
                          <option value="owner">Responsável</option>
                          <option value="staff">Equipe</option>
                        </select>
                      )}
                    </td>
                    <td data-label="Acesso"><span className={`badge ${accessLabel[u.accessStatus][1]}`}>{accessLabel[u.accessStatus][0]}</span></td>
                    <td data-label="Último acesso" className="small">{fmtDateTime(u.lastLoginAt)}</td>
                    <td className="actions">
                      {u.id !== user?.id && (
                        <div className="row-sm" style={{ justifyContent: 'flex-end' }}>
                          {(u.accessStatus === 'convite_pendente' || u.accessStatus === 'convite_expirado') && (
                            <Button size="sm" onClick={() => act.mutate({ u, action: 'invite' })}>Reenviar convite</Button>
                          )}
                          {u.accessStatus === 'ativo' && q.data.mailMode === 'manual' && (
                            <Button size="sm" onClick={() => act.mutate({ u, action: 'reset-link' })}>Link de nova senha</Button>
                          )}
                          <Button size="sm" variant={u.isActive ? 'danger' : 'default'} onClick={() => setToggle(u)}>{u.isActive ? 'Desativar' : 'Reativar'}</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {inviting && <InviteModal onClose={() => setInviting(false)} onLink={(l) => setLink(l)} />}
      {toggle && (
        <ConfirmDialog
          title={toggle.isActive ? 'Desativar acesso' : 'Reativar acesso'}
          message={toggle.isActive ? `${toggle.fullName} perderá o acesso imediatamente.` : `${toggle.fullName} poderá entrar novamente.`}
          danger={toggle.isActive}
          loading={patch.isPending}
          onCancel={() => setToggle(null)}
          onConfirm={() => patch.mutate({ id: toggle.id, body: { isActive: !toggle.isActive } })}
        />
      )}
    </div>
  );
}

function InviteModal({ onClose, onLink }: { onClose: () => void; onLink: (l: { link: string; hours?: number; kind: 'convite' }) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'staff' | 'owner'>('staff');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api.post<InviteResult>('/api/team', { fullName, email, role }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['team'] });
      if (r.inviteLink) onLink({ link: r.inviteLink, hours: r.validHours, kind: 'convite' });
      else toast.success('Convite enviado por e-mail.');
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof ApiError ? e.message : 'Não foi possível convidar.');
    },
  });
  return (
    <Modal title="Convidar pessoa" onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} disabled={!fullName || !email} onClick={() => m.mutate()}>Enviar convite</Button>
      </>
    }>
      <div className="stack">
        {error && <Alert>{error}</Alert>}
        <TextField label="Nome" value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.fullName} />
        <TextField label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <SelectField label="Perfil" value={role} onChange={(e) => setRole(e.target.value as 'staff' | 'owner')}>
          <option value="staff">Equipe (atendimento e cobranças)</option>
          <option value="owner">Responsável (acesso total)</option>
        </SelectField>
        <p className="muted small" style={{ margin: 0 }}>A pessoa recebe um link de uso único para criar a própria senha. Ninguém mais conhece a senha.</p>
      </div>
    </Modal>
  );
}
