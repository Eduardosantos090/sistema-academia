/**
 * Detecção do tipo do arquivo pelo CONTEÚDO (assinatura), nunca pelo nome
 * ou pelo tipo informado pelo navegador. Somente formatos aceitos pelo
 * WhatsApp para imagem, áudio e documento.
 */
export type MediaMime = 'image/jpeg' | 'image/png' | 'audio/ogg' | 'audio/mpeg' | 'audio/mp4' | 'audio/aac' | 'audio/amr' | 'application/pdf';

export const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

export function sniffMime(b: Buffer): MediaMime | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (b.subarray(0, 6).toString('latin1') === '#!AMR\n') return 'audio/amr';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    return /^(M4A |M4B |mp42|isom|mp41|dash)/.test(brand) ? 'audio/mp4' : null;
  }
  if (b.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return 'audio/aac'; // ADTS
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'audio/mpeg'; // quadro MPEG
  return null;
}

export type MediaKind = 'image' | 'audio' | 'document';
export const mediaKind = (mime: string): MediaKind => (mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'document');

export function safeFileName(name: string) {
  const clean = name.normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(0, 80);
  return clean || 'arquivo';
}

export interface MediaRef {
  id: string;
  token: string;
  name: string;
  mime: string;
}

export function mediaUrl(appUrl: string, m: Pick<MediaRef, 'token' | 'name'>) {
  return `${appUrl}/api/media/${m.token}/${encodeURIComponent(safeFileName(m.name))}`;
}
