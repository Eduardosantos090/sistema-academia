import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { mediaPath, type MediaFile } from '../api/types';
import { Button, useToast } from './ui';
import { Icon } from './icons';

const ACCEPT = 'image/jpeg,image/png,audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/amr,audio/x-m4a,.ogg,.opus,.mp3,.m4a,.aac,.amr,application/pdf';
const MAX = 4 * 1024 * 1024;

function toBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^;]*;base64,/, ''));
    r.onerror = () => reject(new Error('Falha ao ler o arquivo.'));
    r.readAsDataURL(file);
  });
}

export async function uploadMedia(file: File): Promise<MediaFile> {
  if (file.size > MAX) throw new Error('Arquivo acima de 4 MB.');
  return api.post<MediaFile>('/api/media', { name: file.name, data: await toBase64(file) });
}

/** Pré-visualização do anexo: imagem, player de áudio ou link do PDF. */
export function MediaPreview({ media, compact }: { media: Pick<MediaFile, 'token' | 'name' | 'mime'>; compact?: boolean }) {
  const src = mediaPath(media);
  if (media.mime.startsWith('image/')) {
    return <img src={src} alt={media.name} style={{ maxWidth: compact ? 180 : 260, maxHeight: compact ? 140 : 220, borderRadius: 10, display: 'block' }} />;
  }
  if (media.mime.startsWith('audio/')) {
    return <audio controls preload="none" src={src} style={{ width: compact ? 220 : 280, maxWidth: '100%' }} />;
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="row-sm small">
      <Icon name="file" /> {media.name}
    </a>
  );
}

/** Escolher/enviar um anexo (imagem, áudio ou PDF). */
export function MediaPicker({ value, onChange, label = 'Anexo (opcional)', disabled }: {
  value: MediaFile | null;
  onChange: (m: MediaFile | null) => void;
  label?: string;
  disabled?: boolean;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      onChange(await uploadMedia(file));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        {value ? (
          <div className="code-box stack-sm" style={{ flex: 1 }}>
            <MediaPreview media={value} />
            <span className="tiny muted">{value.name}</span>
          </div>
        ) : (
          <span className="muted small" style={{ flex: 1 }}>Imagem (JPG/PNG), áudio (OGG, MP3, M4A) ou PDF — até 4 MB.</span>
        )}
        <div className="row-sm">
          <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => void pick(e.target.files?.[0])} />
          <Button size="sm" loading={busy} disabled={disabled} onClick={() => input.current?.click()}>
            <Icon name="plus" size={14} /> {value ? 'Trocar' : 'Anexar'}
          </Button>
          {value && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(null)}>Remover</Button>}
        </div>
      </div>
    </div>
  );
}

const MAX_RECORD_SECONDS = 300;

function pickRecorderType() {
  const types = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return typeof MediaRecorder !== 'undefined' ? types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '' : '';
}

/**
 * Gravar áudio pelo microfone (até 5 min). O navegador grava em Ogg, WebM ou
 * MP4; o servidor converte WebM para Ogg/Opus (mensagem de voz do WhatsApp).
 */
export function AudioRecorder({ onRecorded, disabled }: { onRecorded: (m: MediaFile) => void; disabled?: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'recording' | 'uploading'>('idle');
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const cancelled = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && !!pickRecorderType();

  const stopTracks = () => rec.current?.stream.getTracks().forEach((t) => t.stop());
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    cancelled.current = true;
    if (rec.current?.state === 'recording') rec.current.stop();
    stopTracks();
  }, []);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = pickRecorderType();
      const r = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32000 });
      chunks.current = [];
      cancelled.current = false;
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        stopTracks();
        if (timer.current) clearInterval(timer.current);
        if (cancelled.current || !chunks.current.length) {
          setState('idle');
          return;
        }
        setState('uploading');
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        const blob = new Blob(chunks.current, { type: type.split(';')[0] });
        try {
          onRecorded(await uploadMedia(new File([blob], `audio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type: blob.type })));
        } catch (e) {
          toast.error(e instanceof Error ? e.message : e);
        } finally {
          setState('idle');
        }
      };
      rec.current = r;
      r.start(1000);
      setSeconds(0);
      setState('recording');
      timer.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_RECORD_SECONDS && rec.current?.state === 'recording') rec.current.stop();
          return s + 1;
        });
      }, 1000);
    } catch {
      toast.error('Não foi possível acessar o microfone. Verifique a permissão do navegador.');
    }
  };
  const stop = (cancel: boolean) => {
    cancelled.current = cancel;
    if (rec.current?.state === 'recording') rec.current.stop();
  };

  if (!supported) return null;
  if (state === 'recording') {
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    return (
      <div className="row-sm" role="status" aria-live="polite">
        <span className="rec-dot" aria-hidden /> <span className="num small">{mm}:{ss}</span>
        <Button size="sm" variant="ghost" onClick={() => stop(true)} aria-label="Cancelar gravação">
          <Icon name="x" size={15} />
        </Button>
        <Button size="sm" variant="primary" onClick={() => stop(false)} aria-label="Concluir gravação">
          <Icon name="stop" size={14} /> Concluir
        </Button>
      </div>
    );
  }
  return (
    <Button variant="ghost" className="btn-icon" loading={state === 'uploading'} disabled={disabled} onClick={() => void start()} aria-label="Gravar áudio" title="Gravar áudio">
      <Icon name="mic" />
    </Button>
  );
}
