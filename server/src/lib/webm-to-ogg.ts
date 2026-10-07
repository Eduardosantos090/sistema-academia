/**
 * Conversão (remux, sem recodificar) de áudio WebM/Opus — o formato que o
 * Chrome grava no navegador — para Ogg/Opus, o formato de mensagem de voz
 * aceito pelo WhatsApp. Os pacotes Opus são copiados como estão; só muda o
 * "envelope". Sem dependências externas (funciona em funções serverless).
 */

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

export const isWebm = (b: Buffer) => b.length > 4 && b.subarray(0, 4).equals(EBML_MAGIC);

// Elementos "contêiner" percorridos de forma linear (o conteúdo segue no fluxo).
const MASTER = new Set([0x18538067 /* Segment */, 0x1f43b675 /* Cluster */, 0x1654ae6b /* Tracks */, 0xae /* TrackEntry */, 0xa0 /* BlockGroup */]);
const ID_CODEC = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_TRACK_NUMBER = 0xd7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK = 0xa1;
const ID_EBML = 0x1a45dfa3;

function readVint(b: Buffer, pos: number, keepMarker: boolean) {
  const first = b[pos];
  if (first === undefined || first === 0) throw new Error('VINT inválido');
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > b.length) throw new Error('VINT inválido');
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[pos + i]!;
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

/** Duração (em amostras a 48 kHz) de um pacote Opus, a partir do byte TOC (RFC 6716). */
export function opusPacketSamples(p: Buffer): number {
  if (!p.length) return 0;
  const toc = p[0]!;
  const config = toc >> 3;
  let ms: number;
  if (config < 12) ms = [10, 20, 40, 60][config % 4]!;
  else if (config < 16) ms = [10, 20][config % 2]!;
  else ms = [2.5, 5, 10, 20][config % 4]!;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (p[1] ?? 0) & 0x3f;
  return Math.round(frames * ms * 48);
}

// ------------------------------------------------------------------ Ogg

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(b: Buffer) {
  let crc = 0;
  for (const byte of b) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ byte]!) >>> 0;
  return crc >>> 0;
}

function oggPage(packets: Buffer[], granule: bigint, serial: number, seq: number, flags: number) {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'latin1');
  header[4] = 0;
  header[5] = flags;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(seq, 18);
  header.writeUInt32LE(0, 22);
  header[26] = lacing.length;
  Buffer.from(lacing).copy(header, 27);
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function segmentsOf(p: Buffer) {
  return Math.floor(p.length / 255) + 1;
}

/** Converte WebM/Opus em Ogg/Opus. Lança erro se o arquivo não for áudio Opus em WebM. */
export function webmOpusToOgg(b: Buffer): Buffer {
  let pos = 0;
  let codec = '';
  let codecPrivate: Buffer | null = null;
  let audioTrack: number | null = null;
  let currentTrack: number | null = null;
  const packets: Buffer[] = [];

  while (pos < b.length) {
    let id: ReturnType<typeof readVint>;
    let size: ReturnType<typeof readVint>;
    try {
      id = readVint(b, pos, true);
      size = readVint(b, pos + id.len, false);
    } catch {
      break; // fim truncado (gravação interrompida): usa o que já foi lido
    }
    const dataStart = pos + id.len + size.len;
    if (MASTER.has(id.value)) {
      pos = dataStart; // percorre o conteúdo linearmente
      continue;
    }
    if (size.unknown) throw new Error('Elemento de tamanho desconhecido não suportado.');
    const dataEnd = Math.min(dataStart + size.value, b.length);
    const data = b.subarray(dataStart, dataEnd);
    switch (id.value) {
      case ID_EBML:
        break;
      case ID_TRACK_NUMBER:
        currentTrack = data.reduce((acc, x) => acc * 256 + x, 0);
        break;
      case ID_CODEC:
        codec = data.toString('latin1').replace(/\0+$/, '');
        if (codec === 'A_OPUS' && audioTrack === null) audioTrack = currentTrack ?? 1;
        break;
      case ID_CODEC_PRIVATE:
        if (codec === 'A_OPUS' || (!codec && data.subarray(0, 8).toString('latin1') === 'OpusHead')) codecPrivate = Buffer.from(data);
        break;
      case ID_SIMPLE_BLOCK:
      case ID_BLOCK: {
        const track = readVint(data, 0, false);
        if (audioTrack !== null && track.value !== audioTrack) break;
        const flags = data[track.len + 2]!;
        if (flags & 0x06) throw new Error('Áudio com "lacing" não suportado.');
        packets.push(Buffer.from(data.subarray(track.len + 3)));
        break;
      }
      default:
        break;
    }
    pos = dataEnd;
  }

  if (codec !== 'A_OPUS' && !codecPrivate) throw new Error('O áudio não está em Opus.');
  if (!packets.length) throw new Error('Áudio vazio.');

  const head =
    codecPrivate && codecPrivate.subarray(0, 8).toString('latin1') === 'OpusHead'
      ? codecPrivate
      : (() => {
          const h = Buffer.alloc(19);
          h.write('OpusHead', 0, 'latin1');
          h[8] = 1;
          h[9] = 1; // mono
          h.writeUInt16LE(312, 10);
          h.writeUInt32LE(48000, 12);
          return h;
        })();
  const vendor = Buffer.from('Venceu', 'latin1');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'latin1');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages: Buffer[] = [oggPage([head], 0n, serial, 0, 0x02), oggPage([tags], 0n, serial, 1, 0)];
  let seq = 2;
  let granule = 0n;
  let group: Buffer[] = [];
  let segs = 0;
  const flush = (last: boolean) => {
    if (!group.length) return;
    pages.push(oggPage(group, granule, serial, seq++, last ? 0x04 : 0));
    group = [];
    segs = 0;
  };
  for (const p of packets) {
    const s = segmentsOf(p);
    if (s > 255) continue; // pacote anormal (maior que 64 KB): descartado
    if (segs + s > 255 || group.length >= 50) flush(false);
    group.push(p);
    segs += s;
    granule += BigInt(opusPacketSamples(p));
  }
  flush(true);
  return Buffer.concat(pages);
}
