#!/usr/bin/env node
// Expõe o servidor local na internet (Cloudflare quick tunnel) para receber
// webhooks da Evolution e do Asaas em desenvolvimento.
//
//   npm run tunnel                        → só abre o túnel e imprime as URLs
//   npm run tunnel -- --instance minha-inst
//                                         → também configura o webhook
//                                           TYPEBOT_START da instância na
//                                           Evolution apontando pro túnel
//
// A URL do quick tunnel muda a cada execução — por isso o --instance:
// re-apontar o webhook vira parte de subir o ambiente, não um passo manual.

import { spawn } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(projectRoot, "package.json"));

// Mesma ordem de carga do servidor: .env.local vence .env.
const dotenv = require("dotenv");
const envLocal = path.join(projectRoot, ".env.local");
if (fs.existsSync(envLocal)) dotenv.config({ path: envLocal });
dotenv.config({ path: path.join(projectRoot, ".env") });

const PORT = process.env.PORT || 3000;
const args = process.argv.slice(2);
const instanceFlag = args.indexOf("--instance");
const instanceName = instanceFlag >= 0 ? args[instanceFlag + 1] : null;

const { bin, install } = require("cloudflared");

async function main() {
  if (!fs.existsSync(bin)) {
    console.log("Baixando o binário do cloudflared (primeira execução)…");
    await install(bin);
  }

  console.log(`Abrindo túnel para http://localhost:${PORT} …`);
  const child = spawn(bin, ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout aguardando a URL do túnel (30s).")), 30_000);
    const sniff = (chunk) => {
      const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    };
    // O cloudflared imprime a URL no stderr.
    child.stderr.on("data", sniff);
    child.stdout.on("data", sniff);
    child.on("exit", (code) => reject(new Error(`cloudflared saiu com código ${code}`)));
  });

  const evoToken = process.env.EVOLUTION_WEBHOOK_TOKEN || "";
  const evoWebhookUrl = `${url}/webhooks/evolution?token=${encodeURIComponent(evoToken)}`;

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  Túnel ativo: ${url}`);
  console.log("══════════════════════════════════════════════════════════════\n");
  console.log("Webhooks para colar:");
  console.log(`  • Evolution (TYPEBOT_START): ${evoWebhookUrl}`);
  console.log(`  • Asaas (painel/sandbox):    ${url}/webhooks/asaas`);
  console.log(`      header asaas-access-token = ${process.env.ASAAS_WEBHOOK_TOKEN || "(defina ASAAS_WEBHOOK_TOKEN)"}`);
  if (!process.env.DATABASE_URL) {
    console.log("\n⚠️  Sem DATABASE_URL: as rotas /webhooks/* respondem 404 (créditos e");
    console.log("   status de tenant vivem no Postgres). Para testar webhooks em dev,");
    console.log("   descomente o DATABASE_URL do .env.local apontando pra um Postgres local.");
  }
  console.log("\nPara testar o fluxo OAuth completo (claude.ai → dev), suba o servidor com:");
  console.log(`  PUBLIC_URL=${url}\n`);

  if (instanceName) {
    if (!evoToken) {
      console.error("⚠️  EVOLUTION_WEBHOOK_TOKEN vazio — configure no .env.local antes de usar --instance.");
    } else {
      console.log(`Configurando webhook da instância "${instanceName}" na Evolution…`);
      try {
        const apiUrl = (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
        const res = await fetch(`${apiUrl}/webhook/set/${encodeURIComponent(instanceName)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_GLOBAL_KEY || "" },
          body: JSON.stringify({ enabled: true, url: evoWebhookUrl, events: ["TYPEBOT_START"] }),
        });
        if (!res.ok) throw new Error(`Evolution respondeu ${res.status}: ${await res.text()}`);
        console.log(`✅ Webhook da "${instanceName}" apontando pro túnel (evento TYPEBOT_START).`);
        console.log("   Lembre de re-apontar para a URL de produção depois — a URL do túnel morre com este processo.");
      } catch (err) {
        console.error(`⚠️  Falha ao configurar o webhook: ${err.message}`);
      }
    }
  } else {
    console.log("Dica: npm run tunnel -- --instance <nome> configura o webhook da Evolution sozinho.");
  }

  console.log("\nCtrl+C encerra o túnel.");
  const shutdown = () => {
    child.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
