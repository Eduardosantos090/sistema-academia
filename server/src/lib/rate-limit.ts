import { createHash } from 'node:crypto';
import type pg from 'pg';
import { tooMany } from './errors.js';

/** Limite de tentativas por chave. `consume` lança 429 quando excedido. */
export interface RateLimiter {
  consume(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

/** Janela deslizante em memória: adequado para UMA instância do servidor. */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  async consume(key: string) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      throw tooMany();
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) {
      for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }

  async reset(key: string) {
    this.hits.delete(key);
  }
}

/**
 * Janela fixa compartilhada no PostgreSQL: vale entre várias instâncias
 * (ex.: Netlify Functions). As chaves são gravadas apenas como hash
 * (não armazena e-mail nem IP em texto).
 */
export class PgRateLimiter implements RateLimiter {
  constructor(
    private readonly pool: pg.Pool,
    private readonly bucket: string,
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private hash(key: string) {
    return createHash('sha256').update(`${this.bucket}:${key}`).digest('hex');
  }

  async consume(key: string) {
    const windowStart = new Date(Math.floor(Date.now() / this.windowMs) * this.windowMs);
    const { rows } = await this.pool.query<{ hits: number }>(
      `insert into rate_limit_counters (key_hash, window_start, hits, expires_at)
       values ($1, $2, 1, $3)
       on conflict (key_hash, window_start) do update set hits = rate_limit_counters.hits + 1
       returning hits`,
      [this.hash(key), windowStart, new Date(windowStart.getTime() + this.windowMs)],
    );
    if (rows[0]!.hits > this.max) throw tooMany();
  }

  async reset(key: string) {
    await this.pool.query('delete from rate_limit_counters where key_hash = $1', [this.hash(key)]);
  }
}

export interface Limiters {
  loginIp: RateLimiter;
  loginAccount: RateLimiter;
  resetIp: RateLimiter;
  resetAccount: RateLimiter;
  tokenIp: RateLimiter;
  invite: RateLimiter;
  accessRequestIp: RateLimiter;
  webhookOrg: RateLimiter;
  sendNow: RateLimiter;
  publicIp: RateLimiter;
  mediaIp: RateLimiter;
}

export function createLimiters(store: 'memory' | 'postgres' = 'memory', pool?: pg.Pool): Limiters {
  const min = 60_000;
  const make = (name: string, max: number, windowMs: number): RateLimiter =>
    store === 'postgres' && pool ? new PgRateLimiter(pool, name, max, windowMs) : new MemoryRateLimiter(max, windowMs);
  return {
    loginIp: make('loginIp', 30, 15 * min),
    loginAccount: make('loginAccount', 8, 15 * min),
    resetIp: make('resetIp', 10, 60 * min),
    resetAccount: make('resetAccount', 3, 60 * min),
    tokenIp: make('tokenIp', 20, 15 * min),
    invite: make('invite', 30, 60 * min),
    accessRequestIp: make('accessRequestIp', 5, 60 * min),
    // Webhooks de entrada por organização (proteção contra inundação).
    webhookOrg: make('webhookOrg', 600, 10 * min),
    // Envios manuais por usuário (evita disparo em massa acidental ou abusivo).
    sendNow: make('sendNow', 120, 60 * min),
    publicIp: make('publicIp', 30, 15 * min),
    // Downloads de anexos (servidores do WhatsApp e navegadores).
    mediaIp: make('mediaIp', 600, 10 * min),
  };
}
