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
const bot = createBot({ token, miniAppUrl }, api);

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

// Finish checks already running, then stop polling.
const stop = async () => {
  await bot.stop();
  await bot.idle();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
console.log(`bot @${bot.botInfo.username} started`);
await bot.start({ allowed_updates: ["message", "callback_query", "my_chat_member"] });
