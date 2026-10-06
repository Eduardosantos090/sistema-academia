import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './crypto.js';

/**
 * Cifragem de segredos de integração (tokens do WhatsApp, segredos de webhook)
 * com AES-256-GCM. A chave mestra (SECRETS_KEY) fica só no ambiente do servidor;
 * o banco guarda apenas o texto cifrado. Subchaves separadas para cifrar e assinar.
 */
const subkey = (master: Buffer, purpose: string) => createHmac('sha256', master).update(`venceu:${purpose}`).digest();

export function encryptSecret(master: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', subkey(master, 'enc'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`;
}

/** Retorna null se o valor estiver ausente, corrompido ou cifrado com outra chave. */
export function decryptSecret(master: Buffer, stored: string | null | undefined): string | null {
  if (!stored || !stored.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(stored.slice(3), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', subkey(master, 'enc'), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Assinatura curta (HMAC) para links sem estado, ex.: descadastro de e-mails. */
export function signValue(master: Buffer, purpose: string, value: string): string {
  return createHmac('sha256', subkey(master, 'sig')).update(`${purpose}:${value}`).digest('base64url').slice(0, 32);
}

export function verifySigned(master: Buffer, purpose: string, value: string, signature: string): boolean {
  return safeEqual(signValue(master, purpose, value), signature);
}

export function hmacHex(secret: string | Buffer, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}
