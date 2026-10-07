import { useRef, useState } from 'react';
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
