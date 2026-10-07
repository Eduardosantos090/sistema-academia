import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import type { BotAnswer, Rule, Template, TemplateKind } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import {
  Alert, Button, Checkbox, ConfirmDialog, Empty, Loading, Modal, PageHeader, SelectField, Switch, Tabs, TextArea, TextField,
  fieldErrors, useToast, usePageTitle,
} from '../../components/ui';
import { Icon, WhatsAppIcon } from '../../components/icons';
import { offsetLabel, templateKindLabel } from '../../lib/format';
import { MediaPicker, MediaPreview } from '../../components/Media';
import type { MediaFile } from '../../api/types';
import { useDebounced } from '../../lib/hooks';

type Tab = 'regras' | 'modelos' | 'assistente';

export function AutomationPage() {
  usePageTitle('Automação e assistente');
  const { isOwner } = useAuth();
  const [tab, setTab] = useState<Tab>('regras');
  return (
    <div>
      <PageHeader
        title="Automação e assistente"
        subtitle="Quando avisar, o que dizer e como o assistente virtual responde."
      />
      {!isOwner && <Alert kind="info">Somente o responsável pela conta pode alterar a automação. Você pode consultar as regras.</Alert>}
      <div style={{ height: 12 }} />
      <Tabs<Tab> label="Automação" value={tab} onChange={setTab} tabs={[
        { id: 'regras', label: 'Regras de lembrete' },
        { id: 'modelos', label: 'Modelos de mensagem' },
        { id: 'assistente', label: 'Respostas do assistente' },
      ]} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'regras' && <Rules canEdit={isOwner} />}
        {tab === 'modelos' && <Templates canEdit={isOwner} />}
        {tab === 'assistente' && <Answers canEdit={isOwner} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- regras

function Rules({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<{ items: Rule[] }>('/api/rules') });
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ items: Template[] }>('/api/templates') });
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);
  const save = useMutation({
    mutationFn: (r: Rule) => api.put(`/api/rules/${r.id}`, { offsetDays: r.offsetDays, templateId: r.templateId, sendWhatsapp: r.sendWhatsapp, sendEmail: r.sendEmail, isActive: r.isActive }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['rules'] }),
    onError: (e) => toast.error(e),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/rules/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rules'] });
      setRemoving(null);
    },
    onError: (e) => toast.error(e),
  });
  if (rules.isLoading) return <Loading />;
  const items = rules.data?.items ?? [];
  return (
    <div className="stack">
      <div className="row between">
        <p className="muted small" style={{ margin: 0, maxWidth: 720 }}>
          Todos os dias, no horário de envio definido em Configurações, o Venceu verifica as cobranças em aberto e envia os
          lembretes das regras abaixo. Clientes que avisaram que pagaram não recebem avisos de atraso.
        </p>
        {canEdit && <Button variant="primary" onClick={() => setEditing('new')}><Icon name="plus" /> Nova regra</Button>}
      </div>
      <div className="card">
        {!items.length ? <Empty title="Nenhuma regra" icon="zap" /> : (
          <ul className="list">
            {items.map((r) => (
              <li key={r.id} className="list-item" style={{ opacity: r.isActive ? 1 : 0.55 }}>
                <span className={`offset-pill ${r.offsetDays < 0 ? 'before' : r.offsetDays === 0 ? 'on' : 'after'}`}>
                  {r.offsetDays === 0 ? 'D' : r.offsetDays < 0 ? `D${r.offsetDays}` : `D+${r.offsetDays}`}
                </span>
                <div className="grow">
                  <span className="title">{offsetLabel(r.offsetDays)}</span>
                  <span className="sub row-sm">
                    Modelo: {r.templateName} ·
                    {r.sendWhatsapp && <span className="row-sm" style={{ color: 'var(--whatsapp)' }}><WhatsAppIcon size={14} /> WhatsApp</span>}
                    {r.sendEmail && <span className="row-sm" style={{ color: 'var(--info)' }}><Icon name="mail" size={14} /> E-mail</span>}
                  </span>
                </div>
                {canEdit ? (
                  <>
                    <Switch checked={r.isActive} onChange={(e) => save.mutate({ ...r, isActive: e.target.checked })} label={<span className="sr-only">Regra ativa</span>} aria-label="Regra ativa" />
                    <Button size="sm" variant="ghost" className="btn-icon" aria-label="Editar regra" onClick={() => setEditing(r)}><Icon name="edit" size={16} /></Button>
                    <Button size="sm" variant="ghost" className="btn-icon" aria-label="Excluir regra" onClick={() => setRemoving(r)}><Icon name="trash" size={16} /></Button>
                  </>
                ) : (
                  <span className={`badge ${r.isActive ? 'badge-success' : ''}`}>{r.isActive ? 'Ativa' : 'Inativa'}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && <RuleModal rule={editing === 'new' ? null : editing} templates={templates.data?.items ?? []} onClose={() => setEditing(null)} />}
      {removing && (
        <ConfirmDialog title="Excluir regra" message={`Excluir a regra "${offsetLabel(removing.offsetDays)}"?`} danger confirmLabel="Excluir"
          loading={del.isPending} onCancel={() => setRemoving(null)} onConfirm={() => del.mutate(removing.id)} />
      )}
    </div>
  );
}

function RuleModal({ rule, templates, onClose }: { rule: Rule | null; templates: Template[]; onClose: () => void }) {
  const qc = useQueryClient();
  const initialMode = !rule ? 'antes' : rule.offsetDays < 0 ? 'antes' : rule.offsetDays === 0 ? 'dia' : 'depois';
  const [mode, setMode] = useState<'antes' | 'dia' | 'depois'>(initialMode);
  const [days, setDays] = useState(String(rule ? Math.abs(rule.offsetDays) || 1 : 3));
  const [templateId, setTemplateId] = useState(rule?.templateId ?? templates[0]?.id ?? '');
  const [wa, setWa] = useState(rule?.sendWhatsapp ?? true);
  const [email, setEmail] = useState(rule?.sendEmail ?? true);
  const [error, setError] = useState<string | null>(null);
  const offset = mode === 'dia' ? 0 : (mode === 'antes' ? -1 : 1) * Math.max(1, Number(days) || 1);
  const m = useMutation({
    mutationFn: () => {
      const body = { offsetDays: offset, templateId, sendWhatsapp: wa, sendEmail: email, isActive: rule?.isActive ?? true };
      return rule ? api.put(`/api/rules/${rule.id}`, body) : api.post('/api/rules', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rules'] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? (e.code === 'conflict' ? 'Já existe uma regra para este dia.' : e.message) : 'Não foi possível salvar.'),
  });
  return (
    <Modal title={rule ? 'Editar regra' : 'Nova regra de lembrete'} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} disabled={!templateId || (!wa && !email)} onClick={() => m.mutate()}>Salvar</Button>
      </>
    }>
      <div className="stack">
        {error && <Alert>{error}</Alert>}
        <div className="radio-cards">
          {(['antes', 'dia', 'depois'] as const).map((k) => (
            <label key={k} className="radio-card">
              <input type="radio" name="mode" checked={mode === k} onChange={() => setMode(k)} />
              <span>{k === 'antes' ? 'Antes do vencimento' : k === 'dia' ? 'No dia do vencimento' : 'Depois (atraso)'}</span>
            </label>
          ))}
        </div>
        {mode !== 'dia' && (
          <TextField label="Quantos dias?" type="number" min={1} max={mode === 'antes' ? 30 : 60} value={days} onChange={(e) => setDays(e.target.value)} hint={offsetLabel(offset)} />
        )}
        <SelectField label="Modelo de mensagem" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({templateKindLabel[t.kind]})</option>)}
        </SelectField>
        <div className="row">
          <Checkbox checked={wa} onChange={(e) => setWa(e.target.checked)} label="WhatsApp" />
          <Checkbox checked={email} onChange={(e) => setEmail(e.target.checked)} label="E-mail" />
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------- modelos

function Templates({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['templates'], queryFn: () => api.get<{ items: Template[]; vars: Record<string, string> }>('/api/templates') });
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [removing, setRemoving] = useState<Template | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/templates/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      setRemoving(null);
    },
    onError: (e) => {
      toast.error(e);
      setRemoving(null);
    },
  });
  if (list.isLoading) return <Loading />;
  return (
    <div className="stack">
      <div className="row between">
        <p className="muted small" style={{ margin: 0 }}>Use variáveis como {'{{primeiro_nome}}'} e {'{{valor}}'} — o Venceu preenche para cada cliente.</p>
        {canEdit && <Button variant="primary" onClick={() => setEditing('new')}><Icon name="plus" /> Novo modelo</Button>}
      </div>
      <div className="grid grid-2">
        {list.data?.items.map((t) => (
          <article key={t.id} className="card card-body stack-sm">
            <div className="row between">
              <div>
                <span className="eyebrow">{templateKindLabel[t.kind]}</span>
                <h3 style={{ marginTop: 4 }}>{t.name}</h3>
              </div>
              {canEdit && (
                <div className="row-sm">
                  <Button size="sm" variant="ghost" className="btn-icon" aria-label={`Editar ${t.name}`} onClick={() => setEditing(t)}><Icon name="edit" size={16} /></Button>
                  <Button size="sm" variant="ghost" className="btn-icon" aria-label={`Excluir ${t.name}`} onClick={() => setRemoving(t)}><Icon name="trash" size={16} /></Button>
                </div>
              )}
            </div>
            <div className="code-box small pre-wrap">{t.body}</div>
            {t.media && <MediaPreview media={t.media} compact />}
            <div className="row-sm tiny muted">
              {t.rules > 0 && <span>Usado em {t.rules} regra(s)</span>}
              {t.waTemplateName && <span className="badge badge-whatsapp">Modelo Meta: {t.waTemplateName}</span>}
            </div>
          </article>
        ))}
      </div>
      {editing && <TemplateModal template={editing === 'new' ? null : editing} vars={list.data?.vars ?? {}} onClose={() => setEditing(null)} />}
      {removing && (
        <ConfirmDialog title="Excluir modelo" message={`Excluir o modelo "${removing.name}"?`} danger confirmLabel="Excluir"
          loading={del.isPending} onCancel={() => setRemoving(null)} onConfirm={() => del.mutate(removing.id)} />
      )}
    </div>
  );
}

function TemplateModal({ template, vars, onClose }: { template: Template | null; vars: Record<string, string>; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<TemplateKind>(template?.kind ?? 'lembrete');
  const [name, setName] = useState(template?.name ?? '');
  const [subject, setSubject] = useState(template?.subject ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [waName, setWaName] = useState(template?.waTemplateName ?? '');
  const [waLang, setWaLang] = useState(template?.waTemplateLang ?? 'pt_BR');
  const [media, setMedia] = useState<MediaFile | null>(template?.media ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const dBody = useDebounced(body, 350);
  const dSubject = useDebounced(subject, 350);
  const preview = useQuery({
    queryKey: ['template-preview', dBody, dSubject],
    queryFn: () => api.post<{ body: string; subject: string | null; unknown: string[] }>('/api/templates/preview', { body: dBody, subject: dSubject || null }),
    enabled: dBody.trim().length > 0,
  });
  const insert = (v: string) => {
    const el = ref.current;
    const token = `{{${v}}}`;
    if (!el) return setBody((b) => b + token);
    const s = el.selectionStart ?? body.length;
    const e = el.selectionEnd ?? body.length;
    setBody(body.slice(0, s) + token + body.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  };
  const m = useMutation({
    mutationFn: () => {
      const payload = { kind, name, subject: subject || null, body, waTemplateName: waName || null, waTemplateLang: waLang, mediaId: media?.id ?? null };
      return template ? api.put(`/api/templates/${template.id}`, payload) : api.post('/api/templates', payload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['templates'] });
      void qc.invalidateQueries({ queryKey: ['rules'] });
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    },
  });
  return (
    <Modal size="lg" title={template ? 'Editar modelo' : 'Novo modelo de mensagem'} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} disabled={!name || body.trim().length < 5} onClick={() => m.mutate()}>Salvar modelo</Button>
      </>
    }>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          {error && <Alert>{error}</Alert>}
          <div className="form-grid">
            <TextField label="Nome" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
            <SelectField label="Tipo" value={kind} onChange={(e) => setKind(e.target.value as TemplateKind)}>
              {Object.entries(templateKindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </SelectField>
          </div>
          <TextField label="Assunto do e-mail" value={subject} onChange={(e) => setSubject(e.target.value)} error={errors.subject} />
          <TextArea ref={ref} label="Mensagem" value={body} onChange={(e) => setBody(e.target.value)} rows={9} error={errors.body} maxLength={1500} />
          <div>
            <span className="small muted">Clique para inserir:</span>
            <div>
              {Object.entries(vars).map(([k, v]) => (
                <button key={k} type="button" className="var-chip" title={v} onClick={() => insert(k)}>{`{{${k}}}`}</button>
              ))}
            </div>
          </div>
          <MediaPicker value={media} onChange={setMedia} label="Anexo enviado junto (opcional)" />
          <details>
            <summary className="small" style={{ cursor: 'pointer' }}>WhatsApp API oficial (modelo aprovado pela Meta)</summary>
            <div className="stack-sm" style={{ marginTop: 10 }}>
              <p className="muted small" style={{ margin: 0 }}>
                Mensagens iniciadas pela empresa na API oficial exigem um modelo aprovado. Informe o nome do modelo cadastrado
                no Gerenciador do WhatsApp; as variáveis desta mensagem são enviadas na ordem como {'{{1}}'}, {'{{2}}'}…
              </p>
              <div className="form-grid">
                <TextField label="Nome do modelo na Meta" value={waName} onChange={(e) => setWaName(e.target.value)} error={errors.waTemplateName} placeholder="lembrete_vencimento" />
                <TextField label="Idioma" value={waLang} onChange={(e) => setWaLang(e.target.value)} />
              </div>
            </div>
          </details>
        </div>
        <div className="stack-sm">
          <span className="small muted">Pré-visualização (dados de exemplo)</span>
          <div className="phone-mock">
            <div className="chat-body" style={{ minHeight: 260 }}>
              {preview.data?.subject && <div className="tiny muted">Assunto: {preview.data.subject}</div>}
              {media && <div className="bubble out"><MediaPreview media={media} compact /></div>}
              {preview.data?.body ? <div className="bubble out">{preview.data.body}</div> : <p className="muted small">Escreva a mensagem…</p>}
            </div>
          </div>
          {!!preview.data?.unknown.length && <Alert kind="warning">Variáveis desconhecidas: {preview.data.unknown.join(', ')}</Alert>}
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------- assistente

function Answers({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['bot-answers'], queryFn: () => api.get<{ items: BotAnswer[] }>('/api/bot-answers') });
  const [editing, setEditing] = useState<BotAnswer | 'new' | null>(null);
  const [removing, setRemoving] = useState<BotAnswer | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/bot-answers/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bot-answers'] });
      setRemoving(null);
    },
  });
  if (list.isLoading) return <Loading />;
  return (
    <div className="stack">
      <div className="card card-body stack-sm">
        <h3>Como o assistente funciona</h3>
        <p className="muted small" style={{ margin: 0 }}>
          Ele já entende, sem configuração: <strong>1</strong> vencimentos em aberto · <strong>2</strong> dados de pagamento (PIX e link) ·{' '}
          <strong>3</strong> “já paguei” (marca para sua equipe conferir) · <strong>4</strong> falar com atendente · <strong>SAIR</strong> para
          parar de receber avisos. Abaixo, ensine respostas para dúvidas frequentes do seu negócio — elas têm prioridade e
          podem levar <strong>imagem, áudio ou PDF</strong> (ex.: tabela de preços, áudio de boas-vindas, regulamento).
        </p>
      </div>
      <div className="row between">
        <h3>Respostas personalizadas</h3>
        {canEdit && <Button variant="primary" onClick={() => setEditing('new')}><Icon name="plus" /> Nova resposta</Button>}
      </div>
      <div className="card">
        {!list.data?.items.length ? <Empty title="Nenhuma resposta personalizada" icon="bot" /> : (
          <ul className="list">
            {list.data.items.map((a) => (
              <li key={a.id} className="list-item" style={{ alignItems: 'flex-start', opacity: a.isActive ? 1 : 0.55 }}>
                <span className="green" style={{ marginTop: 2 }}><Icon name="bot" /></span>
                <div className="grow">
                  <span className="title">{a.title} {!a.isActive && <span className="badge">inativa</span>}</span>
                  <div className="row-sm" style={{ margin: '4px 0' }}>{a.keywords.map((k) => <span key={k} className="var-chip">{k}</span>)}</div>
                  <div className="small muted pre-wrap">{a.answer}</div>
                  {a.media && <div style={{ marginTop: 6 }}><MediaPreview media={a.media} compact /></div>}
                </div>
                {canEdit && (
                  <div className="row-sm">
                    <Button size="sm" variant="ghost" className="btn-icon" aria-label={`Editar ${a.title}`} onClick={() => setEditing(a)}><Icon name="edit" size={16} /></Button>
                    <Button size="sm" variant="ghost" className="btn-icon" aria-label={`Excluir ${a.title}`} onClick={() => setRemoving(a)}><Icon name="trash" size={16} /></Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && <AnswerModal answer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {removing && (
        <ConfirmDialog title="Excluir resposta" message={`Excluir "${removing.title}"?`} danger confirmLabel="Excluir"
          loading={del.isPending} onCancel={() => setRemoving(null)} onConfirm={() => del.mutate(removing.id)} />
      )}
    </div>
  );
}

function AnswerModal({ answer, onClose }: { answer: BotAnswer | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(answer?.title ?? '');
  const [keywords, setKeywords] = useState(answer?.keywords.join(', ') ?? '');
  const [text, setText] = useState(answer?.answer ?? '');
  const [isActive, setIsActive] = useState(answer?.isActive ?? true);
  const [media, setMedia] = useState<MediaFile | null>(answer?.media ?? null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [title, keywords, text]);
  const kws = keywords.split(/[,;\n]/).map((k) => k.trim()).filter(Boolean);
  const m = useMutation({
    mutationFn: () => {
      const body = { title, keywords: kws, answer: text, isActive, mediaId: media?.id ?? null };
      return answer ? api.put(`/api/bot-answers/${answer.id}`, body) : api.post('/api/bot-answers', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bot-answers'] });
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    },
  });
  return (
    <Modal title={answer ? 'Editar resposta' : 'Nova resposta do assistente'} onClose={onClose} footer={
      <>
        <Button onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={m.isPending} disabled={!title || !kws.length || text.length < 2} onClick={() => m.mutate()}>Salvar</Button>
      </>
    }>
      <div className="stack">
        {error && <Alert>{error}</Alert>}
        <TextField label="Assunto" value={title} onChange={(e) => setTitle(e.target.value)} error={errors.title} placeholder="Ex.: Horário de funcionamento" />
        <TextField label="Palavras-chave (separadas por vírgula)" value={keywords} onChange={(e) => setKeywords(e.target.value)} error={errors.keywords}
          hint="Se a mensagem do cliente contiver alguma delas, o assistente envia esta resposta. Acentos são ignorados." placeholder="horario, funciona, abre, fecha" />
        <TextArea label="Resposta" value={text} onChange={(e) => setText(e.target.value)} rows={5} error={errors.answer} maxLength={1500} />
        <MediaPicker value={media} onChange={setMedia} label="Enviar junto: imagem, áudio ou PDF (opcional)" />
        <Checkbox checked={isActive} onChange={(e) => setIsActive(e.target.checked)} label="Resposta ativa" />
      </div>
    </Modal>
  );
}
