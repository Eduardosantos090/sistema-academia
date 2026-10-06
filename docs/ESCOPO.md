# Escopo do contrato × entregas

Contrato PMG Code — "Sistema de notificações, cobranças e assistente para academias". A pedido do contratante,
o sistema foi construído de forma **genérica, para qualquer negócio com vencimentos** (academias incluídas).

| Item (Cláusula 1ª) | Entrega |
| --- | --- |
| I – Cadastro de academias, clientes e assinaturas | Organizações (multiempresa), clientes, planos e assinaturas |
| II – Status de assinatura, vencimentos e pagamentos | Assinaturas ativa/pausada/cancelada; cobranças em aberto/atraso/pagas; baixa e estorno |
| III – Notificações de vencimentos, atrasos e renovações | Regras D-N/D/D+N por WhatsApp e e-mail; confirmação de pagamento |
| IV – Automação de cobrança (clientes do contratante e das academias) | Geração recorrente + lembretes automáticos; o contratante usa uma organização própria para cobrar as academias |
| V – Robô/assistente virtual | Chatbot no WhatsApp (vencimentos, PIX, "já paguei", atendente, opt-out, respostas personalizadas) e simulador |
| VI – Painel administrativo | Painel da organização e painel da plataforma, auditoria |
| VII – Configurações de mensagens, avisos e fluxos | Modelos com variáveis, regras, horário, saudação do assistente |
| VIII – Testes, ajustes e publicação | Testes automatizados, CI, guia de publicação Netlify + Supabase/Docker |

Fora do escopo (Cl. 1ª, §2º): app nativo, gateway de pagamento próprio (há campo de link de pagamento e PIX),
nota fiscal, financeiro completo. Custos de terceiros: Cl. 11ª.
