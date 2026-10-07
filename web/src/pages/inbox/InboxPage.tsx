import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../../api/client';
import type { ChatMessage, Conversation, Customer, Paged } from '../../api/types';
import { Alert, Button, Empty, ErrorState, Loading, PageHeader, Segmented, SelectField, Tabs, WhatsAppLink, useToast, usePageTitle } from '../../components/ui';
import { Icon, WhatsAppIcon } from '../../components/icons';
import { fmtDateTime, fmtPhone } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { AudioRecorder, MediaPreview, uploadMedia } from '../../components/Media';
import type { MediaFile } from '../../api/types';

type Tab = 'conversas' | 'simulador';
const statusLabel = { bot: 'Assistente', humano: 'Atendente', encerrada: 'Encerrada' } as const;

export function InboxPage() {
  usePageTitle('Atendimento');
  const [tab, setTab] = useState<Tab>('conversas');
  return (
    <div>
      <PageHeader
        title="Atendimento"
        subtitle="Conversas do WhatsApp atendidas pelo assistente virtual. Quando o cliente pede um atendente, a conversa aparece aqui em destaque."
      />
      <Tabs<Tab> label="Atendimento" value={tab} onChange={setTab} tabs={[{ id: 'conversas', label: 'Conversas' }, { id: 'simulador', label: 'Testar o assistente' }]} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'conversas' ? <Conversations /> : <Simulator />}
      </div>
    </div>
  );
}

function Conversations() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('c');
  const [filter, setFilter] = useState<'todas' | 'humano' | 'bot' | 'encerrada'>('todas');
  const list = useQuery({
    queryKey: ['conversations', filter],
    queryFn: () => api.get<{ items: Conversation[] }>(`/api/conversations${qs({ status: filter })}`),
    refetchInterval: 15_000,
  });
  return (
    <div className="card inbox">
      <div className="inbox-list">
        <div style={{ padding: 10, borderBottom: '1px solid var(--border)' }}>
          <Segmented label="Filtrar conversas" value={filter} onChange={setFilter}
            options={[{ id: 'todas', label: 'Todas' }, { id: 'humano', label: 'Atendente' }, { id: 'bot', label: 'Assistente' }, { id: 'encerrada', label: 'Encerradas' }]} />
        </div>
        {list.isLoading ? <Loading /> : !list.data?.items.length ? (
          <Empty title="Nenhuma conversa" icon="chat"><p className="small">As mensagens recebidas pelo WhatsApp aparecem aqui.</p></Empty>
        ) : (
          list.data.items.map((c) => (
            <button key={c.id} className="inbox-item" aria-current={selected === c.id} onClick={() => setParams({ c: c.id })}>
              <span className="avatar" aria-hidden style={{ width: 36, height: 36, background: c.status === 'humano' ? 'linear-gradient(135deg,#FFC75A,#E08E0B)' : undefined }}>
                {c.customerName ? c.customerName.slice(0, 1).toUpperCase() : '#'}
              </span>
              <span className="grow">
                <span className="row-sm between" style={{ flexWrap: 'nowrap' }}>
                  <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.customerName ?? fmtPhone(c.phone)}</strong>
                  <span className="tiny faint nowrap">{fmtDateTime(c.lastMessageAt).split(' ')[0]}</span>
                </span>
                <span className="preview" style={{ display: 'block' }}>{c.lastMessage}</span>
                <span className={`badge ${c.status === 'humano' ? 'badge-warning' : c.status === 'bot' ? 'badge-info' : ''}`} style={{ marginTop: 4 }}>{statusLabel[c.status]}</span>
              </span>
              {c.unread > 0 && <span className="unread">{c.unread}</span>}
            </button>
          ))
        )}
      </div>
      {selected ? <Chat id={selected} /> : (
        <div className="chat" style={{ display: 'grid', placeItems: 'center' }}>
          <Empty title="Selecione uma conversa" icon="chat" />
        </div>
      )}
    </div>
  );
}

interface ConvDetail extends Conversation {
  messages: ChatMessage[];
}

function Chat({ id }: { id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [waLink, setWaLink] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<MediaFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['conversation', id], queryFn: () => api.get<ConvDetail>(`/api/conversations/${id}`), refetchInterval: 10_000 });
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight });
  }, [q.data?.messages.length]);
  useEffect(() => setWaLink(null), [id]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['conversation', id] });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['counters'] });
  };
  const reply = useMutation({
    mutationFn: () => api.post<{ sent: boolean; waLink: string | null }>(`/api/conversations/${id}/reply`, { text, mediaId: attachment?.id ?? null }),
    onSuccess: (r) => {
      setText('');
      setAttachment(null);
      setWaLink(r.waLink);
      refresh();
    },
    onError: (e) => toast.error(e),
  });
  const setStatus = useMutation({
    mutationFn: (status: 'bot' | 'humano' | 'encerrada') => api.patch(`/api/conversations/${id}`, { status }),
    onSuccess: refresh,
    onError: (e) => toast.error(e),
  });
  if (q.isLoading) return <div className="chat"><Loading /></div>;
  if (q.error || !q.data) return <div className="chat"><ErrorState error={q.error} /></div>;
  const c = q.data;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() || attachment) reply.mutate();
  };
  const attach = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      setAttachment(await uploadMedia(file));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : e);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  return (
    <div className="chat">
      <div className="chat-head">
        <div className="grow" style={{ flex: 1, minWidth: 0 }}>
          <strong>{c.customerName ?? 'Contato sem cadastro'}</strong>
          <div className="muted small">{fmtPhone(c.phone)} {c.customerId && <>· <Link to={`/app/clientes/${c.customerId}`}>ver ficha</Link></>}</div>
        </div>
        <span className={`badge ${c.status === 'humano' ? 'badge-warning' : c.status === 'bot' ? 'badge-info' : ''}`}>{statusLabel[c.status]}</span>
        {c.status !== 'bot' && <Button size="sm" onClick={() => setStatus.mutate('bot')}><Icon name="bot" size={15} /> Devolver ao assistente</Button>}
        {c.status === 'bot' && <Button size="sm" onClick={() => setStatus.mutate('humano')}><Icon name="user" size={15} /> Assumir conversa</Button>}
        {c.status !== 'encerrada' && <Button size="sm" variant="ghost" onClick={() => setStatus.mutate('encerrada')}>Encerrar</Button>}
      </div>
      <div className="chat-body" ref={body} aria-live="polite">
        {c.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.direction} ${m.author === 'bot' ? 'bot' : ''}`}>
            {m.mediaUrl && m.mediaMime && (
              <div style={{ marginBottom: 6 }}>
                <MediaPreview media={{ token: new URL(m.mediaUrl).pathname.split('/')[3]!, name: m.mediaName ?? 'anexo', mime: m.mediaMime }} compact />
              </div>
            )}
            {m.body}
            <span className="meta">
              {fmtDateTime(m.createdAt)} · {m.author === 'bot' ? 'Assistente' : m.author === 'atendente' ? m.userName ?? 'Atendente' : 'Cliente'}
            </span>
          </div>
        ))}
      </div>
      {waLink && (
        <div style={{ padding: '10px 12px 0' }}>
          <Alert kind="info">
            <span className="row-sm">
              Resposta registrada. Como o WhatsApp automático não está configurado, envie pelo seu WhatsApp:
              <WhatsAppLink size="sm" href={waLink} onOpened={() => setWaLink(null)}><WhatsAppIcon size={15} /> Abrir WhatsApp</WhatsAppLink>
            </span>
          </Alert>
        </div>
      )}
      {attachment && (
        <div className="row-sm" style={{ padding: '10px 12px 0' }}>
          <MediaPreview media={attachment} compact />
          <Button size="sm" variant="ghost" onClick={() => setAttachment(null)}>Remover anexo</Button>
        </div>
      )}
      <form className="chat-compose" onSubmit={submit}>
        <input ref={fileInput} type="file" hidden accept="image/jpeg,image/png,audio/*,.ogg,.opus,.mp3,.m4a,.aac,.amr,application/pdf" onChange={(e) => void attach(e.target.files?.[0])} />
        <Button variant="ghost" className="btn-icon" loading={uploading} onClick={() => fileInput.current?.click()} aria-label="Anexar imagem, áudio ou PDF" title="Anexar imagem, áudio ou PDF">
          <Icon name="link" />
        </Button>
        <AudioRecorder onRecorded={setAttachment} disabled={uploading} />
        <textarea
          className="textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Escreva uma resposta… (Enter envia, Shift+Enter quebra linha)"
          aria-label="Resposta"
          maxLength={4000}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (text.trim() || attachment) reply.mutate();
            }
          }}
        />
        <Button type="submit" variant="primary" loading={reply.isPending} disabled={!text.trim() && !attachment} aria-label="Enviar resposta">
          <Icon name="send" />
        </Button>
      </form>
    </div>
  );
}

interface SimMsg { from: 'cliente' | 'bot'; text: string; media?: { url: string; mime: string; name: string } | null }

function Simulator() {
  const [customerId, setCustomerId] = useState('');
  const [search, setSearch] = useState('');
  const dq = useDebounced(search, 300);
  const [msgs, setMsgs] = useState<SimMsg[]>([]);
  const [text, setText] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const customers = useQuery({
    queryKey: ['customers', 'sim', dq],
    queryFn: () => api.get<Paged<Customer>>(`/api/customers${qs({ q: dq, pageSize: 20 })}`),
  });
  useEffect(() => body.current?.scrollTo({ top: body.current.scrollHeight }), [msgs.length]);
  const sim = useMutation({
    mutationFn: (t: string) =>
      api.post<{ replies: string[]; intent: string; media: { url: string; mime: string; name: string } | null }>('/api/bot/simulate', { customerId: customerId || null, text: t }),
    onSuccess: (r) => setMsgs((m) => [...m, ...r.replies.map((x, i) => ({ from: 'bot' as const, text: x, media: i === 0 ? r.media : null }))]),
  });
  const say = (t: string) => {
    if (!t.trim()) return;
    setMsgs((m) => [...m, { from: 'cliente', text: t }]);
    setText('');
    sim.mutate(t);
  };
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <div className="card card-body stack">
        <h2>Teste como o cliente veria</h2>
        <p className="muted small" style={{ margin: 0 }}>
          A simulação usa a mesma lógica do WhatsApp, com os dados reais do cliente escolhido, mas não grava nem envia nada.
        </p>
        <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar cliente…" aria-label="Buscar cliente" />
        <SelectField label="Simular como" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setMsgs([]); }}>
          <option value="">Número sem cadastro</option>
          {customers.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <div className="stack-sm">
          <span className="small muted">Sugestões:</span>
          <div className="row-sm">
            {['Oi', '1', 'Qual o valor que eu devo?', 'pix', 'Já paguei', 'Quero falar com atendente', 'SAIR'].map((s) => (
              <button key={s} type="button" className="var-chip" onClick={() => say(s)}>{s}</button>
            ))}
          </div>
        </div>
        <Button onClick={() => setMsgs([])}><Icon name="refresh" /> Limpar conversa</Button>
      </div>
      <div className="phone-mock">
        <div className="chat-body" ref={body}>
          {msgs.length === 0 && <p className="muted small" style={{ textAlign: 'center', margin: 'auto' }}>Envie “Oi” para começar.</p>}
          {msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.from === 'cliente' ? 'out' : 'in bot'}`}>
              {m.media && (
                <div style={{ marginBottom: 6 }}>
                  <MediaPreview media={{ token: new URL(m.media.url).pathname.split('/')[3]!, name: m.media.name, mime: m.media.mime }} compact />
                </div>
              )}
              {m.text}
            </div>
          ))}
          {sim.isPending && <div className="bubble in bot">digitando…</div>}
        </div>
        <form className="chat-compose" style={{ borderTop: 0, padding: '10px 0 0' }} onSubmit={(e) => { e.preventDefault(); say(text); }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem" aria-label="Mensagem de teste" maxLength={1000} />
          <Button type="submit" variant="primary" aria-label="Enviar mensagem de teste"><Icon name="send" /></Button>
        </form>
      </div>
    </div>
  );
}
