# Segurança e LGPD

## Controles implementados
| Risco | Proteção |
| --- | --- |
| Uma empresa ver dados de outra | **Row Level Security** no PostgreSQL: toda consulta de usuário roda com o papel `venceu_app` (sem BYPASSRLS) e o usuário da sessão; gatilhos impedem vínculos entre organizações mesmo com bug no servidor. A administração da plataforma **não** lê clientes/cobranças das organizações. |
| Escalada de privilégio | Perfis derivados do banco, nunca do navegador; gatilhos impedem virar administrador da plataforma, trocar de organização, alterar o próprio perfil e deixar a organização sem responsável. |
| Roubo de sessão / CSRF | Cookie `__Host-` `httpOnly` `Secure` `SameSite=Strict`, token CSRF por sessão, verificação de origem, expiração absoluta (12 h) e por inatividade (2 h), revogação ao trocar senha/desativar. |
| Força bruta | Limites por IP e por conta (compartilhados no banco em serverless), bloqueio temporário após 8 erros, mensagem genérica e tempo constante. |
| Senhas | scrypt (N=2¹⁵), mínimo de 10 caracteres; convites e redefinições de uso único, token só em hash e no fragmento `#` da URL (não vai para logs). |
| Vazamento de tokens do WhatsApp | AES-256-GCM com `SECRETS_KEY` (fora do banco); nunca devolvidos ao navegador; mensagens de erro do provedor sanitizadas. |
| Webhooks falsos | Endereço aleatório por organização + assinatura HMAC obrigatória (App Secret da Meta ou segredo próprio com carimbo de tempo), comparação em tempo constante, deduplicação por id, limite de requisições e proteção contra laços (bot ↔ bot). |
| SSRF (URL de webhook) | Somente `https` na porta 443, sem credenciais, sem redirecionamento; IP **resolvido** verificado na conexão (bloqueia rede interna, metadados de nuvem e DNS rebinding); tempo e tamanho de resposta limitados. |
| Injeção | SQL sempre parametrizado; validação estrita (Zod `.strict()`); mensagens em texto puro; CSP sem scripts externos; `X-Frame-Options: DENY`. |
| Spam / abuso | Opt-out por WhatsApp (SAIR) e e-mail (link assinado + `List-Unsubscribe`), envios só entre o horário configurado e 21 h, limite de envios manuais por usuário, deduplicação de lembretes. |
| Exposição de erros | Respostas de erro genéricas; logs sem cookies, corpos ou query strings; `/api/health` informa só a categoria da falha. |
| Rastreabilidade | Auditoria somente-inclusão (login, cobranças, pagamentos, exclusões, integrações, equipe). |

Verificado por testes automatizados (`server/test`), incluindo o layout do Supabase.

## LGPD (Cláusula 8ª)
- **Base legal e consentimento**: o cadastro registra se o cliente aceita WhatsApp e e-mail; o contratante é responsável pela base legal (Cl. 8ª, §1º).
- **Direitos do titular**: opt-out a qualquer momento; o responsável pode **excluir definitivamente** os dados de um cliente (cadastro, cobranças, mensagens e conversas).
- **Minimização**: o assistente não usa IA de terceiros — nenhum dado de cliente sai para serviços de IA.
- **Isolamento**: cada organização só acessa os próprios dados; a plataforma vê apenas totais agregados.
- **Retenção**: sessões, tokens e contadores expiram e são limpos automaticamente; envios manuais não feitos expiram em 7 dias.

## Recomendações operacionais
- Guarde `SECRETS_KEY`, senhas do banco e tokens apenas nas variáveis de ambiente; nunca no repositório.
- Ative backups automáticos (Supabase faz backup diário nos planos pagos) e restrinja o acesso ao painel do Supabase/Netlify com 2FA.
- Em incidente: suspenda a organização (Plataforma → Suspender), troque `SECRETS_KEY`/tokens, revise a Auditoria.
