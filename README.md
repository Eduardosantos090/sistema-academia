# Venceu — Lembretes de vencimento com automação de chatbot

Sistema web multiempresa para **academias, escolas, clínicas, estúdios e qualquer negócio com mensalidade**:
controle de clientes, planos e assinaturas, geração automática das cobranças, **lembretes automáticos por
WhatsApp e e-mail**, **assistente virtual (chatbot)** no WhatsApp e painel de acompanhamento.

> Tecnologia desenvolvida pela PMG Code.

## O que o sistema faz

| Área | Recursos |
| --- | --- |
| **Painel** | Recebido e a receber no mês, valor em atraso, adimplência, gráfico de 6 meses, próximos vencimentos, atrasados, pagamentos informados pelo assistente |
| **Clientes** | Cadastro (WhatsApp, e-mail, CPF/CNPJ), situação financeira, histórico de cobranças e mensagens, consentimento por canal, exclusão definitiva (LGPD) |
| **Planos e assinaturas** | Mensal, bimestral, trimestral, semestral e anual; geração automática das cobranças 30 dias antes; pausar, retomar, cancelar, reajustar |
| **Cobranças** | Avulsas ou recorrentes, link de pagamento, baixa manual (PIX, dinheiro, cartão…), estorno, confirmação automática ao cliente |
| **Automação** | Regras D-N / D / D+N por canal, modelos de mensagem com variáveis e pré-visualização, horário de envio, sem envios à noite |
| **WhatsApp** | API oficial da Meta (Cloud API), webhook genérico (Z-API, Evolution API, n8n, Make) ou envio manual em um clique (sem custo) |
| **Assistente virtual** | Vencimentos em aberto, dados de pagamento (PIX/link), "já paguei" (fila de conferência), atendente humano, SAIR (opt-out), respostas personalizadas, simulador |
| **Atendimento** | Caixa de conversas, assumir/devolver ao assistente, responder pelo painel |
| **Plataforma** | Organizações, pedidos de acesso pelo site, suspensão, usuários, auditoria geral |

## Stack

| Camada | Tecnologia |
| --- | --- |
| Frontend | React 19 + TypeScript + Vite, React Router, TanStack Query, CSS com tokens (tema escuro da marca) |
| Backend | Node.js 22 + Fastify 5 + TypeScript, validação com Zod |
| Banco | PostgreSQL 16 com migrações versionadas e **Row Level Security** por organização |
| Autenticação | Sessões no servidor (cookie `httpOnly`, `SameSite=Strict`, `__Host-`), CSRF, convites de uso único, scrypt |
| Publicação | Netlify (site + API como função + automação agendada) e Supabase (PostgreSQL) — ou Docker |
| Testes | Vitest com banco real (isolamento, RLS, automação, webhooks, assistente) |

## Início rápido (desenvolvimento)

Pré-requisitos: Node.js 22+, PostgreSQL 14+.

```bash
npm install
# papéis e banco (uma vez) — ver docs/DEPLOY.md
psql -U postgres -v owner_pw="'senha1'" -v app_pw="'senha2'" -f server/scripts/sql/create-roles.sql
createdb -U postgres -O venceu_owner venceu_dev
cp server/.env.example server/.env      # ajuste as URLs do banco
npm run db:migrate
npm run db:seed-dev                     # opcional: dados FICTÍCIOS, senhas aleatórias no terminal
npm run dev:server                      # API em http://127.0.0.1:3000
npm run dev:web                         # interface em http://localhost:5173
```

## Comandos

| Comando | Função |
| --- | --- |
| `npm run typecheck` | Verificação de tipos (servidor e web) |
| `npm run build` | Build de produção |
| `npm test` | Testes de integração do backend (recria o banco `venceu_test`) |
| `npm run check:netlify` | Verifica o empacotamento das funções do Netlify |
| `npm run db:migrate` | Aplica migrações pendentes |
| `npm run admin:create -- --email ... --name "..."` | Cria o administrador da plataforma (convite) |

## Documentação

- [Publicação (Netlify + Supabase ou Docker)](docs/DEPLOY.md)
- [Integração com o WhatsApp](docs/WHATSAPP.md)
- [Manual de uso](docs/MANUAL.md)
- [Segurança e LGPD](docs/SEGURANCA_E_LGPD.md)
- [Escopo do contrato × entregas](docs/ESCOPO.md)
- [Identidade visual](docs/IDENTIDADE_VISUAL.md)
