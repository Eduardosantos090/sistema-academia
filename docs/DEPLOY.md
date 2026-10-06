# Publicação

## Opção A — Netlify + Supabase (recomendada)

### 1. Banco (Supabase)
1. Crie o projeto (região **South America (São Paulo) – sa-east-1**).
2. Database → Extensions: habilite **citext**.
3. SQL Editor: execute `server/scripts/sql/supabase-setup.sql` trocando as duas senhas.
4. Database → Connect → **Session pooler**: copie o host `aws-0-sa-east-1.pooler.supabase.com` (porta 5432).
   - `DATABASE_OWNER_URL = postgres://venceu_owner.<ref>:<senha>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`
   - `DATABASE_URL       = postgres://venceu_app.<ref>:<senha>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`
5. Aplique as migrações a partir do seu computador:
   `DATABASE_OWNER_URL=... DATABASE_SSL=true npm run db:migrate`

### 2. Site e API (Netlify)
1. Importe o repositório. O `netlify.toml` já define build, função da API (`/api/*`) e a automação a cada 15 min.
2. Variáveis de ambiente (Site configuration → Environment variables):

| Variável | Valor |
| --- | --- |
| `APP_ENV` | `production` |
| `APP_URL` | `https://seu-dominio.com.br` |
| `DATABASE_URL` / `DATABASE_OWNER_URL` | do passo 1 |
| `DATABASE_SSL` | `true` |
| `DATABASE_SSL_CA` | certificado do Supabase (Database → SSL Configuration) |
| `SUPABASE_URL` / `SUPABASE_REGION` | `https://<ref>.supabase.co` / `sa-east-1` (descoberta automática do pooler) |
| `DB_POOL_MAX` | `2` |
| `RATE_LIMIT_STORE` | `postgres` |
| `SECRETS_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` — **guarde em local seguro** |
| `SMTP_USER` / `SMTP_PASSWORD` | e-mail e senha de app (ex.: Gmail) — ou `MAIL_MODE=manual` |
| `MAIL_FROM` | `Venceu <seu-email@dominio.com.br>` |

3. Publique e abra `https://seu-dominio/api/health` — deve responder `{"ok":true,"banco":"ok",…}`.

### 3. Primeiro acesso
```bash
DATABASE_OWNER_URL=... DATABASE_SSL=true APP_URL=https://seu-dominio npm run admin:create -- --email voce@empresa.com.br --name "Seu Nome"
```
Abra o link exibido (uso único, 72 h), defina a senha e, em **Organizações**, cadastre cada empresa cliente
(o responsável recebe o convite). Para cobrar os seus próprios clientes, crie também uma organização para a sua empresa.

## Opção B — Docker / servidor próprio
```bash
docker build -t venceu .
docker run -p 3000:3000 --env-file server/.env venceu
```
No servidor próprio a automação roda dentro do processo (a cada 15 min). Use HTTPS na frente (proxy reverso) e `TRUST_PROXY=true`.

## Custos de terceiros (Cláusula 11)
Hospedagem (Netlify), banco (Supabase), domínio, e-mail e WhatsApp (Meta cobra por conversa iniciada pela empresa;
provedores não oficiais têm mensalidade e risco de bloqueio) são de responsabilidade do contratante.
