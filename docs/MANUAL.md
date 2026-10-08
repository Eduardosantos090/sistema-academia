# Manual de uso

## Primeiros passos (responsável pela empresa)
1. Aceite o convite recebido e defina sua senha.
2. **Configurações → Cobrança e assistente**: informe a chave PIX e as instruções de pagamento; escolha o horário de envio.
3. **Configurações → WhatsApp**: comece no modo Manual ou configure a API oficial (ver docs/WHATSAPP.md).
4. **Planos e assinaturas**: cadastre seus planos (ex.: Mensal R$ 129,90).
5. **Clientes → Novo cliente**: informe WhatsApp/e-mail e marque "Criar assinatura" com o primeiro vencimento.
6. **Configurações → Equipe**: convide atendentes (perfil Equipe).

## E-mail da sua empresa

Em **Configurações → E-mail**, ligue "Enviar os lembretes pelo meu próprio e-mail" e informe o seu e-mail. O provedor
(Gmail, Outlook/Hotmail, iCloud, Yahoo, Hostinger, Locaweb, Zoho) é reconhecido sozinho; para outro, informe o servidor SMTP
e a porta. No Gmail, Outlook, iCloud e Yahoo use uma **senha de app** (a senha normal é recusada) — o passo a passo aparece
na tela. Salve e use **Enviar teste**. A senha fica guardada criptografada e nunca é exibida de novo. Assim cada empresa
envia os lembretes do próprio endereço, e o WhatsApp de cada uma é configurado na aba **WhatsApp**.

## PIX automático (AbacatePay)

Em **Configurações → PIX automático**, cole a chave da **API v2** da AbacatePay (painel da AbacatePay → Integração → Chaves de API)
e clique em **Ligar PIX automático**. Comece com uma chave em **modo de teste** para validar o fluxo sem cobrar ninguém.
(As chaves da v1 e da v2 da AbacatePay não são intercambiáveis: use uma chave v2.)

- Cada lembrete passa a levar um **link de pagamento** (variáveis `{{link_pagamento}}` e `{{instrucoes_pagamento}}`). O link abre
  uma página com QR Code e PIX copia e cola, gerados na hora pela AbacatePay. O botão de copiar link também aparece em **Cobranças**.
- Quando o cliente paga, a cobrança é baixada sozinha, os lembretes pendentes dela são cancelados e o cliente recebe a confirmação.
- **Aviso de pagamento (webhook):** no painel da AbacatePay, em Integração → Webhooks, cadastre a URL e o segredo mostrados na tela.
  Mesmo sem o webhook, o Venceu confere os PIX pendentes a cada poucos minutos.
- A baixa só acontece depois de o Venceu consultar a AbacatePay com a sua chave — um aviso falso não dá baixa em nada.
- No modo de teste, a página de pagamento mostra **Simular pagamento**, para conferir o fluxo completo.
- Na empresa de cobrança da plataforma (Eduardo), a baixa de uma mensalidade renova automaticamente o acesso da academia.

## Venda online da assinatura (administração do Venceu)

Em **Plataforma → Venda online**:

1. Cole a chave da API v2 da AbacatePay (permissões de clientes, produtos e assinaturas) e o **ID do produto** de assinatura
   (ex.: `prod_XkFSP4HpB41XDPPXyMtKj5am`). O preço e o ciclo vêm do produto na AbacatePay.
2. Escolha as formas de pagamento (cartão; PIX Automático só se estiver habilitado na sua conta AbacatePay) e clique em
   **Ligar venda online**.
3. Na AbacatePay, em Integração → Webhooks, cadastre a URL e o segredo mostrados na tela, com os eventos de assinatura.

A página de vendas passa a mostrar o preço e o botão **Assinar**. A pessoa preenche os dados da empresa e cria a senha, paga na
AbacatePay e a conta é criada automaticamente (com modelos, regras e assistente prontos) — ela já entra com o e-mail e a senha.
Cada renovação paga estende o acesso por mais um período; se a assinatura for cancelada ou não for paga, o acesso termina no fim
do período (mais a tolerância) e a conta é suspensa. A lista de cadastros aparece na mesma tela.

## Importar clientes de uma planilha
Em **Clientes → Importar planilha**: baixe o modelo ou use a sua planilha salva como **CSV** (Excel: Arquivo → Salvar como → CSV).
Colunas reconhecidas: Nome (obrigatória), WhatsApp/Celular, E-mail, CPF, Plano, Valor, Periodicidade e Vencimento (data ou só o dia do mês).
Com Vencimento + Plano (nome de um plano cadastrado) ou Valor, a assinatura é criada e as cobranças são geradas. Quem já está
cadastrado (mesmo WhatsApp ou e-mail) é ignorado, e as linhas com problema são listadas para correção. Até 2.000 clientes por vez.

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

## Novidades
- **Anexos (imagem, áudio, PDF)**: em Automação → Respostas do assistente e → Modelos, anexe um arquivo (até 4 MB) que vai junto da mensagem. No Atendimento, use o clipe para enviar imagem, áudio ou PDF ao cliente, ou o **microfone** para gravar um áudio na hora (até 5 min). O áudio gravado é convertido automaticamente para o formato de mensagem de voz do WhatsApp (Ogg/Opus).
- **Intervalo entre mensagens**: Configurações → Cobrança e assistente → "Intervalo entre mensagens" (segundos ou minutos). Os disparos saem um a um nesse ritmo, reduzindo o risco de bloqueio do WhatsApp.
- **Controle de envios**: mostra, para cada cobrança em atraso ou que vence no período, se o cliente já recebeu o lembrete, se falta, se está na fila ou se falhou. Selecione e envie, ou use "Enviar para quem falta".
- **Painel**: bloco "Próximos vencimentos — hoje, 1, 2 e 3 dias", com quem já recebeu lembrete.

## Plataforma: planos e acesso dos clientes (Eduardo)
- **Ativar/Desativar acesso**: na lista de Organizações (botão na linha) ou na página da organização.
- **Ativar plano manualmente**: na organização → "Plano e acesso" → +1 mês, +3, +6 ou 1 ano (libera e reativa).
- **Suspensão automática**: marque "Suspender automaticamente se vencer" e a tolerância em dias.
- **Cobrança automática**: escolha em Organizações a sua "Organização de cobrança" (a sua empresa dentro do Venceu). Na organização do cliente, defina o valor do plano e clique em "Ativar cobrança automática": o cliente vira um assinante na sua organização, recebe os lembretes e, quando você registrar o pagamento, o acesso dele é renovado sozinho (e reativado, se estava suspenso por atraso).
