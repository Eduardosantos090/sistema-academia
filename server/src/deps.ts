import type { Config } from './config.js';
import type { Deps } from './lib/context.js';
import { createPools, createPoolsResolved } from './lib/db.js';
import { createMailer, createOrgMailer, type Mailer, type OrgMailerFactory } from './lib/mailer.js';
import { createLimiters } from './lib/rate-limit.js';
import { safeFetch, type HttpFetch } from './lib/http.js';

export async function createDeps(config: Config, overrides: { mailer?: Mailer; orgMailer?: OrgMailerFactory; fetch?: HttpFetch } = {}): Promise<Deps> {
  // Com Supabase configurado, descobre o endereço do pooler se o informado não funcionar.
  const { pools, info } =
    config.SUPABASE_URL && config.SUPABASE_REGION
      ? await createPoolsResolved(config)
      : { pools: createPools(config), info: { auto: false, tlsUnverified: false } };
  return {
    config,
    pools,
    dbInfo: info,
    mailer: overrides.mailer ?? createMailer(config),
    orgMailer: overrides.orgMailer ?? createOrgMailer,
    limiters: createLimiters(config.RATE_LIMIT_STORE, pools.owner),
    fetch: overrides.fetch ?? safeFetch,
  };
}
