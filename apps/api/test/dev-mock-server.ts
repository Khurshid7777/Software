// Local dev server: real API + real DB + local photo storage, deterministic AI from fixtures,
// fake STT and a channel publisher that only logs. No Anthropic key or bot token needed.
//   pnpm --filter @ishonch/api dev:mock
import { buildApp } from "../src/app.js";
import { buildInitData } from "../src/auth/telegram.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { FsStorage } from "../src/storage/storage.js";
import { readFileSync } from "node:fs";
import { PROMPTS_DIR } from "@ishonch/shared/node";
import { fixtures, listingFixtures, mockAiByPrompt } from "./helpers.js";
import { prepareDemoUsers, registerDemoLogin } from "./demo-login.js";

const assistantCases = JSON.parse(readFileSync(`${PROMPTS_DIR}__fixtures__/assistant.json`, "utf8")).cases;

const botToken = process.env.BOT_TOKEN ?? "123456:DEV";
const config = loadConfig({ ...process.env, BOT_TOKEN: botToken, NODE_ENV: "development" });
const { db } = createDb(config.DATABASE_URL);
const check = fixtures.find((f) => f.name === (process.env.FIXTURE ?? "iphone13_prepay_ru"))!;
const listing = listingFixtures.find((f) => f.name === (process.env.LISTING_FIXTURE ?? "samsung_a54_photo_only_ru"))!;

const ai = mockAiByPrompt({
  check_extract: check.mock_extract,
  check_report: {
    pros: ["Свежая модель", "Хорошая батарея"],
    cons: ["Подозрительно низкая цена", "Продавец в другом городе"],
    questions: ["Можно встретиться в Ташкенте?", "Какой IMEI?", "Отвязан ли iCloud?", "Был ли ремонт?", "Есть ли чек?"],
    extra_red_flags: [],
    risk_adjustment: 5,
  },
  // Assistant: always "laptop for video editing ≤ 8M", recommends the first 3 real candidates.
  assistant_query: assistantCases[0]!.mock_query,
  assistant_recommend: (call: { content: Array<{ text: string }> }) => {
    const ctx = JSON.parse(call.content[0]!.text) as { candidates: Array<{ id: string; title: string }> };
    return {
      summary: "Для монтажа лучше всего подходит вариант с мощной видеокартой. Обязательно осмотрите ноутбук перед оплатой.",
      options: ctx.candidates.slice(0, 3).map((c, i) => ({
        listing_id: c.id,
        pros: [["Мощная видеокарта RTX 3060", "16 ГБ ОЗУ"], ["Тихий и автономный", "Цена в рынке"], ["Дёшево"]][i] ?? ["—"],
        cons: [["Батарея ~3 часа"], ["8 ГБ ОЗУ мало для 4K"], ["Слабый процессор для монтажа"]][i] ?? ["—"],
        fit: ["Лучший выбор для монтажа", "Подойдёт для монтажа в Full HD", "Только для простых задач"][i] ?? "",
      })),
    };
  },
  assistant_compare: (call: { content: Array<{ text: string }> }) => {
    const ctx = JSON.parse(call.content[0]!.text) as { listings: Array<{ id: string }> };
    return {
      summary: "Для видеомонтажа берите Lenovo Legion: видеокарта и 16 ГБ ОЗУ важнее автономности. Проверьте температуру под нагрузкой.",
      verdicts: ctx.listings.map((l, i) => ({ listing_id: l.id, best_for: ["монтаж и игры", "автономность и тишина", "учёба"][i] ?? "" })),
    };
  },
  listing_analyze: listing.mock_analysis,
  listing_generate: listing.mock_text,
  listing_moderate: { decision: "approved", reasons: [], seller_message_ru: "", seller_message_uz: "" },
  // A real clip uploaded in the demo passes the video passport; a file that is not a video never gets here.
  video_check: {
    device_visible: true,
    powered_on: true,
    identifier_screen: true,
    battery_screen: true,
    account_screen: true,
    body_shown: true,
    screen_damage: "none",
    concerns: [],
    note_ru: "Устройство включается, экран IMEI и аккумулятора видны, аккаунт отвязан.",
    note_uz: "Qurilma yonadi, IMEI va batareya ekrani ko'rinadi, akkaunt bog'lanmagan.",
  },
  chat_suggest: {
    replies: [
      "Да, ещё в продаже. Состояние как на фото, без ремонтов.",
      "Можно оформить доставку с осмотром через Ishonch — курьер привезёт, оплата после проверки.",
      "Цена окончательная, но доставку могу оплатить пополам.",
    ],
  },
});

const app = await buildApp({
  config,
  db,
  ai,
  storage: new FsStorage(process.env.STORAGE_DIR ?? "./data/storage"),
  stt: { name: "fake", transcribe: async () => listing.input || "Samsung A54" },
  publisher: {
    post: async (channelId, post) => {
      console.log(`[channel ${channelId}] ${post.caption.replace(/\n/g, " | ")} [${post.button.text} → ${post.button.url}]`);
      return { messageId: 1 };
    },
    miniAppLink: async (p) => `https://t.me/ishonch_dev_bot/app?startapp=${p}`,
    send: async (chatId, text, buttons) => {
      console.log(`[dm ${chatId}] ${text.replace(/\n/g, " | ")} ${JSON.stringify(buttons ?? [])}`);
    },
  },
});
// Demo mode (docker-compose.demo.yml): a page with one-click logins as the demo users, outside Telegram.
const demo = process.env.DEMO === "1";
if (demo) registerDemoLogin(app, botToken);

await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? "127.0.0.1" });
if (demo) await prepareDemoUsers(app, config.INTERNAL_API_TOKEN);
const user = { id: Number(process.env.DEV_USER_ID ?? 777000111), first_name: "Dev", language_code: process.env.E2E_LANG ?? "ru" };
console.log("INIT_DATA=" + buildInitData(user, botToken));
