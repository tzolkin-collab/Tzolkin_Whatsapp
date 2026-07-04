# Runbook — Onboarding de cliente (piloto)

> Roteiro operacional para colocar um cliente novo no ar. Vale para venda manual
> (você conduz) e como referência do que o self-service faz sozinho.
> Pré-requisito: deploy com `DATABASE_URL`, `ADMIN_API_KEY`, `ASAAS_API_KEY`,
> `ASAAS_WEBHOOK_TOKEN` e `EVOLUTION_WEBHOOK_TOKEN` configurados, webhook
> cadastrado no painel do Asaas.

---

## Fluxo A — Cliente veio pela LP (self-service)

O checkout da LP já faz quase tudo: cria o tenant **suspenso**, cria customer +
assinatura no Asaas e mostra a `accessKey` + link de pagamento. Quando o
pagamento confirma, o webhook ativa o tenant e credita os `WELCOME_CREDITS`.

Sua parte (por enquanto manual):

1. **Criar a instância** do cliente via tool `create_instance` (com seu token
   admin) ou pelo manager da Evolution. Convenção de nome: o slug do tenant
   (ex.: `padaria-do-joao-a1b2c3`).
2. **Vincular a instância ao tenant**:
   ```
   PATCH /admin/tenants/:id   { "instances": ["<nome-da-instancia>"] }
   ```
   ⚠️ O checkout cria o tenant com `instances: ["*"]` — **troque para a lista
   explícita**, senão o cliente enxerga todas as instâncias do servidor.
3. **Configurar o webhook da instância** (medição de créditos):
   ```
   configure_webhook → url: <PUBLIC_URL>/webhooks/evolution?token=<EVOLUTION_WEBHOOK_TOKEN>
                       events: ["TYPEBOT_START"]
   ```
4. Mandar pro cliente: link do painel (`/config.html`), a chave de acesso, e o
   passo a passo de conexão (abaixo).

## Fluxo B — Venda manual (sem passar pela LP)

1. Criar tenant + billing num comando:
   ```
   POST /admin/tenants
   x-admin-key: <ADMIN_API_KEY>
   {
     "id": "cliente-slug",
     "name": "Nome da Empresa",
     "instances": ["cliente-slug"],
     "billing": { "cpfCnpj": "...", "email": "...", "value": 197, "cycle": "MONTHLY" }
   }
   ```
   → Anote a `accessKey` (aparece **uma única vez**). O tenant nasce ativo;
   se quiser condicionar ao pagamento, faça `PATCH { "status": "suspended" }`
   até o webhook confirmar.
2. Seguir os passos 1, 3 e 4 do Fluxo A.

## Conexão do WhatsApp (cliente)

**Plano padrão (Baileys/QR):**
1. Cliente entra no painel com a chave → aba de instâncias → "Conectar".
2. Escaneia o QR: WhatsApp → Aparelhos conectados → Conectar um aparelho.
3. Alternativa sem painel: rodar `connect_instance` e mandar o `qrPageUrl`
   (página com QR auto-atualizável, link válido por 10 min).

**Plano API Oficial (Meta Cloud API):**
1. Conduzir o cadastro do cliente na Meta (Business Manager → WhatsApp →
   número verificado). Coletar: **token permanente**, **phone number ID**,
   **WABA ID**.
2. `create_instance` com `integration: "WHATSAPP-BUSINESS"`, `token`, `number`
   (phone number ID) e `businessId` (WABA). Não há QR — nasce conectada.

## Conector no Claude (cliente)

1. claude.ai → Settings → Connectors → Add custom connector →
   URL: `<PUBLIC_URL>/mcp`.
2. Na tela de autorização, colar a **chave de acesso** e autorizar.
3. Teste: pedir ao Claude "liste minhas instâncias do WhatsApp" — deve
   aparecer só a(s) do cliente.

## Chatbot (Typebot) e créditos

1. Fluxos são criados no Typebot hospedado da Tzolkin; o cliente vincula na
   aba Typebot do painel (URL do viewer + nome do fluxo + gatilho).
2. Créditos: saldo inicial = `WELCOME_CREDITS`. Compra pelo painel
   (`/api/client/credits/checkout`) → boleto/PIX Asaas → credita sozinho.
3. Cortesia/estorno: `POST /admin/tenants/:id/credits { "credits": 50, "reason": "..." }`.
4. **Sem saldo, sessões novas do bot são encerradas na hora** — oriente o
   cliente a acompanhar o saldo no painel.

## Troubleshooting rápido

| Sintoma | Causa provável | Ação |
| :--- | :--- | :--- |
| Cliente autoriza mas tools dão "Acesso negado" | `instances` do tenant não contém a instância | `PATCH /admin/tenants/:id` |
| Tudo dá 401 de repente | Tenant suspenso (pagamento) ou token revogado | `GET /admin/tenants` → status; reautorizar |
| QR não conecta | Sessão Baileys velha | `logout_instance` e conectar de novo |
| Bot não debita créditos | Webhook da instância sem `TYPEBOT_START` ou token errado | conferir `get_webhook_settings` |
| Bot parou de responder | Créditos zerados | `GET /admin/tenants/:id/credits` |
| Cliente perdeu a chave | Não é recuperável (só hash no banco) | `POST /admin/tenants/:id/rotate-key` + reautorizar |

## Encerramento de cliente

1. `POST /admin/tenants/:id/revoke-tokens` (mata o acesso na hora).
2. Cancelar a assinatura no painel do Asaas.
3. `logout_instance` + `delete_instance`.
4. `DELETE /admin/tenants/:id`.
