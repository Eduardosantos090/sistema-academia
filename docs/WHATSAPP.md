# Integração com o WhatsApp

Cada organização escolhe em **Configurações → WhatsApp**:

## 1. Manual (padrão, sem custo)
Os lembretes do dia ficam em **Mensagens → Para enviar no WhatsApp**. Um clique abre o WhatsApp (Web ou celular)
com a mensagem pronta; ao abrir, a mensagem é marcada como enviada. O assistente automático não responde neste modo.

## 2. API oficial da Meta (WhatsApp Business Cloud API)
Envio e assistente 100% automáticos, sem risco de bloqueio por automação.
1. Meta for Developers → crie um app Business → adicione o produto **WhatsApp** e um número.
2. Gere um **token permanente** (Usuário do sistema no Business Manager, permissão `whatsapp_business_messaging`).
3. Copie o **ID do número** e o **App Secret** (Configurações do app → Básico).
4. No Venceu, salve os três dados. Copie a **URL de callback** e o **token de verificação** exibidos.
5. Na Meta: WhatsApp → Configuração → Webhook: cole URL e token e assine o campo **messages**.
6. **Lembretes exigem modelo aprovado** (mensagem iniciada pela empresa fora da janela de 24 h): crie os modelos
   na Meta (categoria *Utilidade*) com o mesmo texto e informe o nome em cada modelo do Venceu. As variáveis
   (`{{primeiro_nome}}`, `{{valor}}`…) são enviadas na ordem em que aparecem como `{{1}}`, `{{2}}`…
7. Use **Testar envio** para validar.

Segurança: toda mensagem recebida é validada pela assinatura `X-Hub-Signature-256` (App Secret). Os tokens são
cifrados no banco (AES-256-GCM com `SECRETS_KEY`) e nunca voltam ao navegador.

## 3. Webhook genérico (Z-API, Evolution API, n8n, Make…)
**Envio** — o Venceu faz `POST` na sua URL (https, porta 443, sem redirecionamento):
```json
{ "event": "message.send", "organization": "slug", "messageId": "uuid", "to": "+5511999999999", "text": "…", "template": null }
```
Cabeçalhos: `X-Venceu-Timestamp: <unix>` e `X-Venceu-Signature: sha256=<hex>` com
`HMAC_SHA256(segredo, "<timestamp>.<corpo>")`. Responda 2xx (opcionalmente `{ "id": "..." }`).

**Recebimento (assistente)** — encaminhe as mensagens recebidas para a URL de entrada exibida no painel:
```json
{ "from": "5511999999999", "text": "1", "id": "id-unico-da-mensagem (obrigatório)" }
```
assinadas da mesma forma (tolerância de 5 minutos). A resposta traz `{ "replies": ["…"], "intent": "vencimentos" }`
— envie os textos de `replies` ao cliente. O `id` evita duplicidade em reenvios.

Observação: provedores não oficiais podem ter o número bloqueado pelo WhatsApp (Cláusula 7ª, §1º).

## Anexos e intervalo entre envios
- Imagem (JPG/PNG), áudio (OGG/Opus, MP3, M4A, AAC, AMR) e PDF, até 4 MB. O WhatsApp baixa o arquivo por um link com identificador aleatório (`/api/media/<token>/<nome>`).
- API oficial: imagem e PDF levam o texto como legenda; áudio vai em mensagem separada. Fora da janela de 24 h a Meta só aceita modelos aprovados — anexos de lembretes funcionam melhor via webhook (Z-API/Evolution) ou dentro da conversa.
- Webhook: o corpo do envio inclui `media: { url, mime, name, kind }`; a resposta do webhook de entrada inclui `media` quando a resposta do assistente tem anexo.
- Modo manual: o link do anexo é incluído no texto da mensagem.
- O **intervalo entre mensagens** (Configurações) vale para o envio automático: uma mensagem por vez, no ritmo escolhido. A rotina roda a cada minuto.

## Comandos que o assistente entende
| Cliente envia | Resposta |
| --- | --- |
| oi, menu, 0 | Saudação e menu |
| 1, vencimento, quanto devo, boleto… | Cobranças em aberto (de todos os cadastros com aquele número) |
| 2, pix, pagar, link… | Chave PIX, link de pagamento e instruções |
| 3, já paguei, comprovante… | Registra aviso de pagamento para a equipe conferir (sem cobrança de atraso enquanto isso) |
| 4, atendente, ajuda… | Passa para a equipe (o bot silencia até devolverem) |
| SAIR / receber avisos | Opt-out / opt-in dos lembretes por WhatsApp |
| Palavras-chave cadastradas | Respostas personalizadas (prioridade) |

O WhatsApp às vezes identifica celulares antigos sem o 9º dígito: o Venceu reconhece as duas formas.
