# WhatsApp Evolution API MCP Server

Um servidor de **Model Context Protocol (MCP)** para integrar a **Evolution API (v2)** diretamente com assistentes de IA (como Claude Desktop, Cursor e outros). Ele expõe ferramentas para gerenciamento de instâncias, envio de mensagens, configuração de chatbots (Typebot) e webhooks.

---

## 🚀 Como Começar

### 1. Pré-requisitos
*   Node.js (versão 18 ou superior)
*   Instância ativa da **Evolution API v2**

### 2. Instalação e Compilação
No diretório deste projeto (`whatsapp_manager`), execute os seguintes comandos no terminal:

```bash
# Instalar dependências
npm install

# Compilar o código TypeScript
npm run build
```

---

## ⚙️ Configuração das Variáveis de Ambiente

O servidor MCP precisa saber o endereço da sua Evolution API e a chave global (Admin Key) para se autenticar. 

1. Crie um arquivo `.env` na raiz do projeto (copiando do `.env.example`):
   ```env
   EVOLUTION_API_URL=https://api.seudominio.com
   EVOLUTION_GLOBAL_KEY=sua-chave-global-da-evolution-api
   PUBLIC_URL=https://seu-deploy.easypanel.host
   ```

### Multi-tenant com Postgres + billing Asaas (recomendado para produção)

Com `DATABASE_URL` definido, os tenants vivem no Postgres (tabelas `wa_tenants` e `wa_tokens`, criadas automaticamente) e o servidor ganha:

- **Revogação de token** (`/revoke` OAuth + admin API) e **suspensão instantânea** — o escopo é resolvido no banco a cada request.
- **API admin** (habilitada por `ADMIN_API_KEY`, header `x-admin-key`):
  - `POST /admin/tenants` `{id, name, instances, admin?, billing?}` → cria o tenant e retorna a **chave de acesso (uma única vez)**. Com `billing: {cpfCnpj, email, value, cycle?, billingType?}` também cria o cliente + assinatura no Asaas.
  - `GET /admin/tenants` · `PATCH /admin/tenants/:id` (instances/status/name) · `DELETE /admin/tenants/:id`
  - `POST /admin/tenants/:id/rotate-key` · `POST /admin/tenants/:id/revoke-tokens`
- **Webhook Asaas** em `POST /webhooks/asaas` (habilitado por `ASAAS_WEBHOOK_TOKEN`, validado contra o header `asaas-access-token` configurado no painel do Asaas): `PAYMENT_OVERDUE` suspende o tenant; `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` reativa.

```env
DATABASE_URL=postgres://user:pass@host:5432/db
ADMIN_API_KEY=chave-admin-para-provisionar-tenants
ASAAS_API_KEY=sua-api-key-do-asaas
ASAAS_WEBHOOK_TOKEN=token-configurado-no-webhook-do-asaas
# ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3   (para testes)
```

Fluxo de venda: `POST /admin/tenants` com billing → manda a `accessKey` pro cliente → cliente adiciona o conector no Claude e digita a chave no consent → Asaas cobra mensalmente e o webhook mantém o status.

### Créditos do chatbot (Typebot hospedado)

**Modelo:** 1 crédito = 1 sessão de chatbot iniciada (evento `TYPEBOT_START` da Evolution). Ledger append-only em `wa_credit_ledger` (idempotente por `ref`).

- **Medição:** configure o webhook das instâncias para `POST <PUBLIC_URL>/webhooks/evolution?token=<EVOLUTION_WEBHOOK_TOKEN>` com o evento `TYPEBOT_START`. Cada sessão debita 1 crédito do tenant dono da instância; **sem saldo, a sessão é encerrada na hora** (`changeTypebotStatus closed`).
- **Compra:** `POST /api/client/credits/checkout {packId}` cria cobrança avulsa no Asaas com `externalReference: credits:<tenantId>:<qty>`; o webhook do Asaas credita o ledger ao confirmar (idempotente entre `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED`).
- **Painel:** `GET /api/client/credits` → `{balance, history, packs}`. Admin: `GET/POST /admin/tenants/:id/credits` (ajuste manual ±).
- **Envs:** `EVOLUTION_WEBHOOK_TOKEN` (habilita a medição), `CREDIT_PACKS_JSON` (default: 100/R$49, 500/R$199, 2000/R$599), `WELCOME_CREDITS` (default 20, creditados no checkout).

### API da aba Typebot (`/api/client`, Bearer = chave de acesso)

| Rota | Ação |
| :--- | :--- |
| `GET /instances/:name/typebot` | Fluxos vinculados + defaults da instância |
| `PUT /instances/:name/typebot` | Cria (sem `typebotId`) ou atualiza (com `typebotId`) fluxo — aceita gatilhos (`triggerType/Operator/Value`) e comportamento (`expire`, `keywordFinish`, `delayMessage`, `unknownMessage`, `keepOpen`, `stopBotFromMe`, `debounceTime`) |
| `DELETE /instances/:name/typebot/:typebotId` | Remove o fluxo |
| `GET /instances/:name/typebot/:typebotId/sessions` | Sessões em andamento |
| `POST /instances/:name/typebot/sessions/:remoteJid` | `{status: opened\|paused\|closed}` |
| `POST /instances/:name/typebot/test` | `{number, url, typebot}` — dispara o fluxo para um número |

### Multi-tenant estático (alternativa sem banco): `TENANTS_JSON`

Sem `TENANTS_JSON`, o servidor opera em modo single-tenant: qualquer pessoa que autorize na tela de consent ganha acesso total (comportamento original). Com `TENANTS_JSON` definido, a tela de consent passa a exigir uma **chave de acesso**, e o token OAuth emitido fica **escopado às instâncias daquele tenant**:

```env
TENANTS_JSON={"haylander": {"key": "chave-secreta-do-cliente", "instances": ["haylander-main"]}, "admin": {"key": "chave-do-admin", "instances": "*"}}
```

- `instances: [...]` — o tenant só enxerga/opera essas instâncias. `list_instances` é filtrado; `create_instance`/`delete_instance` são negados.
- `instances: "*"` — tenant admin, acesso total (incluindo criar/excluir instâncias).
- Chaves devem ter 8+ caracteres. A validação é constant-time e o escopo viaja dentro do próprio token assinado (stateless — funciona com múltiplas réplicas).

## 🔌 Endpoints MCP

| Endpoint | Transporte | Nota |
| :--- | :--- | :--- |
| `/mcp` | **Streamable HTTP** | Recomendado (spec MCP atual) |
| `/sse` + `/messages` | SSE | Legado, mantido por compatibilidade |

Ambos exigem OAuth (Bearer token). O fluxo de autorização é iniciado automaticamente pelo cliente MCP (Claude, Cursor, etc.).

*(Nota: Você também pode passar essas variáveis diretamente no arquivo de configuração do Claude Desktop ou Cursor, como detalhado abaixo).*

---

## 🤖 Integração com Clientes de IA

### 1. Claude Desktop

Para integrar com o **Claude Desktop**, você deve editar o arquivo de configurações global dele. No Windows, ele geralmente fica em:
`%APPDATA%\Claude\claude_desktop_config.json` (geralmente `C:\Users\SEU_USUARIO\AppData\Roaming\Claude\claude_desktop_config.json`).

Abra o arquivo e adicione o servidor sob a propriedade `mcpServers`:

```json
{
  "mcpServers": {
    "whatsapp-evolution": {
      "command": "node",
      "args": [
        "d:/Códigos/Tzolkin/.tzolkin/.tools/whatsapp_manager/build/index.js"
      ],
      "env": {
        "EVOLUTION_API_URL": "https://api.seudominio.com",
        "EVOLUTION_GLOBAL_KEY": "sua-chave-global-da-evolution-api"
      }
    }
  }
}
```

*Certifique-se de usar caminhos absolutos e barras normais `/` (como mostrado acima).*

---

### 2. Cursor / Antigravity

Para registrar este servidor MCP no **Cursor**:

1. Vá em **Cursor Settings** (ícone de engrenagem no canto superior direito) -> **Features** -> **MCP**.
2. Clique em **+ Add New MCP Server**.
3. Preencha as configurações:
   *   **Name**: `whatsapp-evolution`
   *   **Type**: `command`
   *   **Command**:
       ```bash
       node "d:/Códigos/Tzolkin/.tzolkin/.tools/whatsapp_manager/build/index.js"
       ```
4. Adicione as variáveis de ambiente necessárias (`EVOLUTION_API_URL` e `EVOLUTION_GLOBAL_KEY`) no menu correspondente do Cursor ou certifique-se de que elas estão carregadas no seu sistema / arquivo `.env`.

---

## 🛠️ Ferramentas Disponíveis

Este servidor exporta as seguintes ferramentas (tools) para o seu modelo de IA usar:

| Categoria | Nome da Ferramenta | Descrição |
| :--- | :--- | :--- |
| **Instância** | `list_instances` | Lista todas as instâncias configuradas e seus status de conexão. |
| **Instância** | `create_instance` | Cria uma nova instância de WhatsApp — `WHATSAPP-BAILEYS` (pareamento por QR do número existente) ou `WHATSAPP-BUSINESS` (Cloud API oficial da Meta; exige `token` permanente, `number` = phone number ID e `businessId` = WABA). |
| **Instância** | `connect_instance` | Obtém o QR Code (como imagem inline) e um link `qrPageUrl` para uma página no navegador que atualiza o QR a cada 20s para escanear. |
| **Instância** | `get_instance_status` | Verifica o status da conexão (CONNECTED, DISCONNECTED, etc.). |
| **Instância** | `logout_instance` | Desconecta a sessão ativa do WhatsApp. |
| **Instância** | `delete_instance` | Exclui definitivamente uma instância do servidor. |
| **Mensagens** | `send_text` | Envia mensagens de texto para contatos ou grupos. |
| **Mensagens** | `send_media` | Envia imagens, vídeos, áudios ou documentos (por URL ou Base64). |
| **Typebot** | `configure_typebot` | Configura e ativa a integração do Typebot em uma instância. |
| **Typebot** | `get_typebot_settings` | Exibe as configurações atuais do Typebot na instância. |
| **Typebot** | `change_typebot_status` | Abre, pausa ou fecha a sessão de atendimento do Typebot para um contato. |
| **Typebot** | `start_typebot_flow` | Inicia manualmente um fluxo do Typebot para um contato específico. |
| **Webhook** | `configure_webhook` | Configura os webhooks para receber notificações e mensagens recebidas. |
| **Webhook** | `get_webhook_settings` | Consulta os webhooks atualmente configurados na instância. |
