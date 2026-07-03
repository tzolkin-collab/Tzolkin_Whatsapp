# Roteiro de Onboarding do Piloto

Este é o passo a passo para colocar o primeiro cliente rodando na infraestrutura multi-tenant.

## 1. Criar o Tenant (Admin API)

Faça uma requisição para a sua própria API de Admin (que você subiu no Easypanel) para provisionar o tenant do cliente.

```bash
curl -X POST https://<seu-deploy>/admin/tenants \
  -H "x-admin-key: <sua-admin-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "cliente1",
    "name": "Nome do Cliente",
    "instances": ["cliente1_wa"],
    "billing": {
      "name": "Nome do Cliente",
      "cpfCnpj": "00000000000",
      "email": "cliente@email.com",
      "value": 197.00,
      "cycle": "MONTHLY",
      "billingType": "PIX",
      "description": "Mensalidade Conector WhatsApp x Claude"
    }
  }'
```
> **Nota:** Se o `billing` for omitido, o tenant será criado sem integração automática com o Asaas.

**A resposta será algo como:**
```json
{
  "id": "cliente1",
  "accessKey": "tz_wa_...",
  "asaas": {
    "customerId": "cus_...",
    "subscriptionId": "sub_..."
  }
}
```

**Guarde a `accessKey` gerada. Ela será mostrada apenas uma vez.**

## 2. Configurar o Cliente no Claude

1. O cliente (ou você na conta do cliente) acessa o **Claude** (claude.ai ou Claude Desktop).
2. Adiciona o **Conector WhatsApp** na configuração de MCPs ou ferramentas.
3. Insere a `accessKey` gerada acima na configuração do MCP (no Claude do cliente).
4. Pede para o Claude: *"Conecte meu WhatsApp"* ou *"Me mostre o status do WhatsApp"*.

## 3. Pareamento por QR Code

1. O Claude chamará a ferramenta de status e identificará que a instância está desconectada.
2. O Claude deve invocar a ferramenta `connect_instance` para a instância `cliente1_wa`.
3. A ferramenta retornará o **QR Code** (em base64 ou link).
4. O cliente abre o WhatsApp no celular: **Configurações > Aparelhos conectados > Conectar um aparelho**.
5. O cliente escaneia o QR Code gerado pelo Claude.

## 4. Teste de Funcionamento

1. Assim que parear, peça para o Claude: *"Faça um resumo das minhas últimas conversas não lidas"*.
2. O Claude deve ler as mensagens usando `get_messages` e responder com sucesso.
3. Faça um teste de envio: *"Mande um 'Oi, teste' para o número X"*.

## 5. Manutenção e Cobrança (Dia a Dia)

- O webhook do Asaas configurado no Easypanel cuidará automaticamente da suspensão e reativação.
- Se o cliente não pagar o PIX ou boleto até o vencimento, o evento `PAYMENT_OVERDUE` mudará o status do tenant para `suspended`. A chave `tz_wa_...` será invalidada até que o pagamento seja feito (`PAYMENT_RECEIVED`).
- Se precisar rotacionar a chave do cliente por questões de segurança, chame `POST /admin/tenants/cliente1/rotate-key`.
