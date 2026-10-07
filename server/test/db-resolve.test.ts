import { describe, expect, it } from 'vitest';
import { resolveDbUrl, type Probe } from '../src/lib/db-resolve.js';
import { sslOptions } from '../src/lib/db.js';
import { SUPABASE_ROOT_CA } from '../src/lib/supabase-ca.js';

const opts = { supabaseUrl: 'https://zilqdwjmzgqcrvzpibji.supabase.co', region: 'ca-central-1', caProvided: false };
const configured = 'postgres://venceu_app.zilqdwjmzgqcrvzpibji:s3nha@aws-0-ca-central-1.pooler.supabase.com:6543/postgres';
const err = (code: string, message = code) => Object.assign(new Error(message), { code });

describe('resolução do banco', () => {
  it('certificado do Supabase embutido é um PEM válido', () => {
    const ssl = sslOptions(true, SUPABASE_ROOT_CA);
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    expect((ssl as { ca: string }).ca).toContain('-----BEGIN CERTIFICATE-----');
  });

  it('host lento não atrasa: prefere o configurado, senão o primeiro que conecta', async () => {
    const probe: Probe = async (url) => {
      if (url.includes('aws-0')) { await new Promise((r) => setTimeout(r, 50)); throw err('XX000', 'Tenant or user not found'); }
    };
    const t = Date.now();
    const r = await resolveDbUrl(configured, sslOptions(true, SUPABASE_ROOT_CA), { ...opts, probe });
    expect(r.url).toContain('aws-1-ca-central-1');
    expect(r.auto).toBe(true);
    expect(r.tlsUnverified).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('se o certificado não validar, cai para TLS sem verificação e sinaliza', async () => {
    const probe: Probe = async (_url, ssl) => {
      if ((ssl as { rejectUnauthorized: boolean }).rejectUnauthorized) throw err('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain');
    };
    const r = await resolveDbUrl(configured, sslOptions(true, SUPABASE_ROOT_CA), { ...opts, probe });
    expect(r.url).toBe(configured);
    expect(r.tlsUnverified).toBe(true);
  });

  it('senha recusada é o erro relatado', async () => {
    const probe: Probe = async (url) => { throw url.includes('aws-1') ? err('28P01') : err('ECONNREFUSED'); };
    await expect(resolveDbUrl(configured, undefined, { ...opts, probe })).rejects.toMatchObject({ code: '28P01' });
  });
});
