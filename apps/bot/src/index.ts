import { createServer } from "node:http";
import { run } from "@grammyjs/runner";
import { webhookCallback } from "grammy";
import { ApiClient } from "./api.js";
import { createBot } from "./bot.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is not set");
  process.exit(1);
}

const api = new ApiClient(
  process.env.API_URL ?? "http://localhost:3000",
  process.env.INTERNAL_API_TOKEN ?? "dev-internal-token",
);
const miniAppUrl = process.env.MINIAPP_URL ?? "https://example.com";
// Webhook mode when a public URL is set (production behind nginx); long polling otherwise (dev).
const webhookUrl = process.env.BOT_WEBHOOK_URL ?? "";
const webhookSecret = process.env.BOT_WEBHOOK_SECRET ?? "";
const port = Number(process.env.BOT_PORT ?? 8081);

const bot = createBot({ token, miniAppUrl }, api);
const allowed_updates = ["message", "callback_query", "my_chat_member"] as const;

await bot.init();
await bot.api.setMyCommands([
  { command: "start", description: "Ishonch" },
  { command: "help", description: "Yordam / Помощь" },
  { command: "sell", description: "Sotish / Продать" },
  { command: "lang", description: "Til / Язык" },
]);
await bot.api.setChatMenuButton({
  menu_button: { type: "web_app", text: "Ishonch", web_app: { url: miniAppUrl } },
});

let stopUpdates: () => Promise<unknown>;
if (webhookUrl) {
  if (webhookSecret.length < 16) {
    console.error("BOT_WEBHOOK_SECRET (16+ characters) is required with BOT_WEBHOOK_URL");
    process.exit(1);
  }
  // Telegram signs each delivery with the secret token; grammY rejects requests without it.
  const handle = webhookCallback(bot, "http", { secretToken: webhookSecret, timeoutMilliseconds: 9_000 });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") return void res.end("ok");
    if (req.method === "POST" && req.url === new URL(webhookUrl).pathname) return void handle(req, res);
    res.statusCode = 404;
    res.end();
  });
  server.listen(port);
  await bot.api.setWebhook(webhookUrl, { secret_token: webhookSecret, allowed_updates: [...allowed_updates] });
  stopUpdates = () => new Promise((r) => server.close(r));
  console.log(`bot @${bot.botInfo.username}: webhook ${webhookUrl} (port ${port})`);
} else {
  await bot.api.deleteWebhook();
  const runner = run(bot, { runner: { fetch: { allowed_updates: [...allowed_updates] } } });
  stopUpdates = () => runner.stop();
  console.log(`bot @${bot.botInfo.username}: long polling`);
}

// Stop receiving updates, finish checks already running, then exit.
const stop = async () => {
  await stopUpdates();
  await bot.idle();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
