# Manual de uso

## Primeiros passos (responsável pela empresa)
1. Aceite o convite recebido e defina sua senha.
2. **Configurações → Cobrança e assistente**: informe a chave PIX e as instruções de pagamento; escolha o horário de envio.
3. **Configurações → WhatsApp**: comece no modo Manual ou configure a API oficial (ver docs/WHATSAPP.md).
4. **Planos e assinaturas**: cadastre seus planos (ex.: Mensal R$ 129,90).
5. **Clientes → Novo cliente**: informe WhatsApp/e-mail e marque "Criar assinatura" com o primeiro vencimento.
6. **Configurações → Equipe**: convide atendentes (perfil Equipe).

## Rotina do dia
- **Painel**: veja quem vence hoje, quem está em atraso e os avisos de "já paguei".
- **Mensagens → Para enviar no WhatsApp** (modo manual): envie os lembretes com um clique.
- **Cobranças → A conferir**: confira no extrato e clique em **Pago** (o cliente recebe a confirmação) ou em **Não encontrei**.
- **Atendimento**: responda quem pediu um atendente; devolva ao assistente quando terminar.

## Automação
- **Regras de lembrete**: padrão D-3 (antes), D (no dia), D+3 e D+10 (atraso). Ative/desative ou crie novas.
- **Modelos**: edite os textos com variáveis como `{{primeiro_nome}}`, `{{valor}}`, `{{vencimento}}`, `{{instrucoes_pagamento}}`.
- **Respostas do assistente**: ensine respostas para dúvidas comuns (horário, endereço, planos…) por palavras-chave.
- **Testar o assistente** (em Atendimento): simule a conversa como qualquer cliente, sem enviar nada.

## Perfis
| Ação | Responsável | Equipe |
| --- | --- | --- |
| Clientes, cobranças, pagamentos, assinaturas | ✅ | ✅ |
| Mensagens e atendimento | ✅ | ✅ |
| Planos, regras, modelos, respostas do assistente | ✅ | consulta |
| Configurações, integrações, equipe, auditoria | ✅ | — |
| Excluir dados de cliente (LGPD) | ✅ | — |

## Plataforma (administração do Venceu)
- **Organizações**: cadastre empresas (já nascem com modelos, regras e assistente), suspenda/reative, gerencie usuários.
- **Pedidos de acesso**: aprove com um clique os pedidos feitos pelo site.
