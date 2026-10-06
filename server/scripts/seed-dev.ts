/**
 * Dados FICTÍCIOS apenas para desenvolvimento e demonstração local.
 * Recusa execução fora de APP_ENV=development. Senhas são geradas
 * aleatoriamente a cada execução e exibidas somente neste terminal.
 *
 *   npm run db:seed-dev
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslFromEnv } from '../src/lib/db.js';
import { loadDotEnv } from '../src/lib/dotenv.js';
import { hashPassword } from '../src/lib/crypto.js';

loadDotEnv();
if (process.env.APP_ENV !== 'development') {
  console.error('Seed permitido somente com APP_ENV=development.');
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL!, ssl: sslFromEnv() });
await client.connect();

const existing = await client.query('select count(*)::int as n from users');
if (existing.rows[0].n > 0 && !process.argv.includes('--force')) {
  console.error('O banco já possui usuários. Use --force para adicionar dados fictícios mesmo assim.');
  await client.end();
  process.exit(1);
}

const suffix = randomBytes(2).toString('hex');
const creds: { perfil: string; email: string; senha: string }[] = [];

async function user(email: string, name: string, orgId: string | null, role: string | null, platform = false) {
  const pw = randomBytes(9).toString('base64url');
  const { rows } = await client.query<{ id: string }>(
    'insert into users (email, full_name, organization_id, role, is_platform_admin) values ($1, $2, $3, $4, $5) returning id',
    [email, name, orgId, role, platform],
  );
  await client.query('insert into user_credentials (user_id, password_hash) values ($1, $2)', [rows[0]!.id, await hashPassword(pw)]);
  creds.push({ perfil: platform ? 'Plataforma' : `${role} @ ${orgId?.slice(0, 8)}`, email, senha: pw });
  return rows[0]!.id;
}

const first = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João', 'Karen', 'Lucas',
  'Mariana', 'Nicolas', 'Olívia', 'Pedro', 'Rafaela', 'Samuel', 'Tatiane', 'Vinícius', 'Yasmin', 'Rodrigo', 'Letícia', 'Murilo'];
const last = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Lima', 'Costa', 'Almeida', 'Ribeiro', 'Carvalho', 'Gomes', 'Martins'];

try {
  await client.query('begin');
  await user(`plataforma.${suffix}@exemplo.test`, 'Administração Venceu', null, null, true);

  const orgs = [
    { name: 'Academia Força Total (FICTÍCIA)', slug: `forca-total-${suffix}`, segment: 'academia', plans: [['Plano Mensal', 12990, 1], ['Plano Trimestral', 34990, 3], ['Plano Anual', 119900, 12]] },
    { name: 'Escola de Inglês Talk (FICTÍCIA)', slug: `talk-${suffix}`, segment: 'escola', plans: [['Mensalidade Regular', 39000, 1], ['Mensalidade Intensivo', 59000, 1]] },
  ] as const;

  for (const o of orgs) {
    const { rows } = await client.query<{ id: string }>(
      `insert into organizations (name, slug, segment, contact_email, contact_phone, pix_key, payment_instructions)
       values ($1, $2, $3, $4, '+5511900000000', 'financeiro@exemplo.test', 'Após o pagamento, responda com o comprovante.') returning id`,
      [o.name, o.slug, o.segment, `contato.${o.slug}@exemplo.test`],
    );
    const orgId = rows[0]!.id;
    await client.query('select app.seed_org_defaults($1)', [orgId]);
    await user(`dono.${o.slug}@exemplo.test`, 'Responsável Fictício', orgId, 'owner');
    await user(`equipe.${o.slug}@exemplo.test`, 'Atendente Fictício', orgId, 'staff');
    const planIds: { id: string; name: string; amount: number; interval: number }[] = [];
    for (const [name, amount, interval] of o.plans) {
      const p = await client.query<{ id: string }>(
        'insert into plans (organization_id, name, amount_cents, interval_months) values ($1, $2, $3, $4) returning id',
        [orgId, name, amount, interval],
      );
      planIds.push({ id: p.rows[0]!.id, name, amount, interval });
    }
    for (let i = 0; i < 22; i++) {
      const name = `${first[(i * 7) % first.length]} ${last[(i * 5) % last.length]}`;
      // Números da faixa reservada a ficção (não pertencem a pessoas reais).
      const phone = `+55119${String(10000000 + i * 137 + (o.segment === 'academia' ? 0 : 5000)).slice(0, 8)}`;
      const c = await client.query<{ id: string }>(
        `insert into customers (organization_id, name, email, phone) values ($1, $2, $3, $4) returning id`,
        [orgId, name, `cliente${i}.${o.slug}@exemplo.test`, phone],
      );
      const plan = planIds[i % planIds.length]!;
      const offset = (i % 9) * 4 - 16; // vencimentos espalhados entre -16 e +16 dias
      const due = new Date(Date.now() + offset * 86_400_000);
      const day = due.getUTCDate();
      const s = await client.query<{ id: string }>(
        `insert into subscriptions (organization_id, customer_id, plan_id, description, amount_cents, interval_months, next_due_date, billing_day)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [orgId, c.rows[0]!.id, plan.id, plan.name, plan.amount, plan.interval, due.toISOString().slice(0, 10), day],
      );
      // Histórico pago dos últimos meses (para os gráficos).
      for (let m = 1; m <= 4; m++) {
        const past = new Date(due);
        past.setUTCMonth(past.getUTCMonth() - m * plan.interval);
        if (Date.now() - past.getTime() > 200 * 86_400_000) continue;
        await client.query(
          `insert into charges (organization_id, customer_id, subscription_id, description, amount_cents, due_date, status, paid_at, paid_amount_cents, payment_method)
           values ($1, $2, $3, $4, $5, $6, 'paga', $6::date + (($7 % 4) || ' days')::interval, $5, 'pix')`,
          [orgId, c.rows[0]!.id, s.rows[0]!.id, plan.name, plan.amount, past.toISOString().slice(0, 10), i],
        );
      }
    }
    await client.query('select app.generate_charges(null, 30)');
    // Alguns já pagos e um aviso de "já paguei" para conferência.
    await client.query(
      `update charges set status = 'paga', paid_at = now() - interval '1 day', paid_amount_cents = amount_cents, payment_method = 'pix'
        where id in (select id from charges where organization_id = $1 and status = 'aberta' and due_date < current_date order by random() limit 3)`,
      [orgId],
    );
    await client.query(
      `update charges set reported_paid_at = now() - interval '2 hours'
        where id in (select id from charges where organization_id = $1 and status = 'aberta' and due_date < current_date limit 1)`,
      [orgId],
    );
  }
  await client.query('commit');
  console.log('\nDados FICTÍCIOS criados. Credenciais (somente desenvolvimento):\n');
  console.table(creds);
} catch (e) {
  await client.query('rollback');
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
