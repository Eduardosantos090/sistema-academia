import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import https from 'node:https';
import net from 'node:net';

export interface HttpResult {
  status: number;
  body: string;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

/** Cliente HTTP de saída. Injetável para testes. */
export type HttpFetch = (url: string, req: HttpRequest) => Promise<HttpResult>;

export class OutboundError extends Error {}

// Redes privadas, locais, reservadas e de metadados de nuvem (IPv4).
const BLOCKED = new net.BlockList();
for (const [base, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(base, bits, 'ipv4');
}
// IPv6: só endereços públicos (2000::/3), exceto 6to4, Teredo e documentação.
const V6_PUBLIC = new net.BlockList();
V6_PUBLIC.addSubnet('2000::', 3, 'ipv6');
const V6_BLOCKED = new net.BlockList();
for (const [base, bits] of [['2002::', 16], ['2001::', 32], ['2001:db8::', 32]] as const) V6_BLOCKED.addSubnet(base, bits, 'ipv6');

/**
 * Endereços privados, locais, reservados ou de metadados de nuvem (proteção
 * contra SSRF). IPv6 só é aceito na faixa pública global — isso também cobre
 * as formas mapeadas/compatíveis de IPv4 (::ffff:7f00:1, ::127.0.0.1…).
 */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '');
  if (net.isIPv4(addr)) return BLOCKED.check(addr, 'ipv4');
  if (net.isIPv6(addr)) return !V6_PUBLIC.check(addr, 'ipv6') || V6_BLOCKED.check(addr, 'ipv6');
  return true;
}

/** Valida o formato de uma URL de destino informada por usuário. */
export function validateOutboundUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OutboundError('URL inválida.');
  }
  if (u.protocol !== 'https:') throw new OutboundError('Use um endereço https://.');
  if (u.username || u.password) throw new OutboundError('Não inclua usuário ou senha na URL.');
  if (u.port && u.port !== '443') throw new OutboundError('Use a porta padrão (443).');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isBlockedAddress(u.hostname.replace(/^\[|\]$/g, ''))) {
    throw new OutboundError('Endereço não permitido.');
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(u.hostname)) throw new OutboundError('Endereço não permitido.');
  return u;
}

const MAX_RESPONSE = 256 * 1024;

/**
 * HTTPS de saída seguro: só https, sem redirecionamentos, tempo limite, resposta
 * limitada e verificação do IP RESOLVIDO no momento da conexão (impede SSRF e
 * DNS rebinding para a rede interna ou serviços de metadados).
 */
export const safeFetch: HttpFetch = (rawUrl, req) =>
  new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = validateOutboundUrl(rawUrl);
    } catch (e) {
      reject(e);
      return;
    }
    const lookup = (
      hostname: string,
      options: object,
      cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
    ) => {
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return cb(err, '');
        const list = addresses as LookupAddress[];
        if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
          return cb(Object.assign(new Error('Endereço de destino não permitido.'), { code: 'EBLOCKED' }), '');
        }
        if ((options as { all?: boolean }).all) return cb(null, list);
        cb(null, list[0]!.address, list[0]!.family);
      });
    };
    const r = https.request(
      url,
      {
        method: req.method,
        headers: { 'user-agent': 'Venceu/1.0', ...(req.headers ?? {}) },
        lookup: lookup as never,
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE) {
            r.destroy(new OutboundError('Resposta grande demais.'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new OutboundError('Tempo de resposta esgotado.')));
    r.on('error', (e) => reject(e instanceof OutboundError ? e : new OutboundError(errorLabel(e))));
    if (req.body) r.write(req.body);
    r.end();
  });

function errorLabel(e: Error & { code?: string }) {
  if (e.code === 'EBLOCKED') return 'Endereço de destino não permitido.';
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return 'Endereço de destino não encontrado.';
  if (e.code === 'ECONNREFUSED') return 'Conexão recusada pelo destino.';
  return 'Falha de comunicação com o destino.';
}
