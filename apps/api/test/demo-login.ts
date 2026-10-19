import type { FastifyInstance } from "fastify";
import { buildInitData } from "../src/auth/telegram.js";

/** Demo users: the demo catalog's sellers (dev-seed-catalog.ts), a buyer, an operator and an admin. */
const DEMO_USERS = [
  { id: 777_000_111, lang: "ru", icon: "🛒", title: "Покупатель", hint: "Каталог, карточка, чат, заказ с доставкой, встреча" },
  { id: 999_000_002, lang: "ru", icon: "👤", title: "Частный продавец", hint: "Свои объявления, «Продать», предложения цены" },
  { id: 999_000_001, lang: "uz", icon: "🏪", title: "Магазин Malika Tech", hint: "Проверенный магазин, запросы покупателей (узбекский язык)" },
  { id: 777_000_222, lang: "ru", icon: "🚚", title: "Оператор доставки", hint: "Заказы на доставку, курьеры и статусы" },
  { id: 777_000_333, lang: "ru", icon: "🛠", title: "Администратор", hint: "Админка: метрики, модерация, жалобы, тарифы" },
] as const;

/**
 * `GET /demo`: one-click logins as the demo users. Outside Telegram the Mini App takes signed initData from
 * the URL; links are signed on every page load, so they never expire while the page is fresh.
 */
export function registerDemoLogin(app: FastifyInstance, botToken: string) {
  app.get("/demo", async (_req, reply) => {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    const cards = DEMO_USERS.map((u) => {
      const initData = buildInitData({ id: u.id, first_name: u.title, language_code: u.lang }, botToken);
      return `<a class="card" href="/?initData=${esc(encodeURIComponent(initData))}"><span class="icon">${u.icon}</span><span><strong>${u.title}</strong><small>${u.hint}</small></span></a>`;
    }).join("");
    return reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Ishonch — демо</title>
<style>
body{margin:0;font:16px/1.4 -apple-system,system-ui,sans-serif;background:#f1f2f4;color:#111;display:flex;justify-content:center}
main{max-width:420px;width:100%;padding:24px 16px}h1{margin:0 0 4px}p{color:#666;margin:0 0 20px}
.card{display:flex;gap:14px;align-items:center;background:#fff;border-radius:14px;padding:14px 16px;margin-bottom:10px;color:inherit;text-decoration:none}
.card:hover{outline:2px solid #1f8f5f}.icon{font-size:28px}small{display:block;color:#666;font-size:13px}
.note{font-size:13px;color:#888;margin-top:16px}
</style></head><body><main><h1>Ishonch — демо</h1>
<p>Войти как один из демо-пользователей. Telegram не нужен, данные тестовые.</p>${cards}
<p class="note">Совет: откройте в режиме телефона (DevTools → Toggle device toolbar) или прямо с телефона в той же сети. Чтобы сменить роль, вернитесь на эту страницу.</p>
</main></body></html>`);
  });
}

/** Accepts the terms and sets a phone for every demo user, so the consent screens do not get in the way. */
export async function prepareDemoUsers(app: FastifyInstance, internalToken: string) {
  for (const u of DEMO_USERS) {
    const headers = { authorization: `Internal ${internalToken}`, "x-telegram-user": JSON.stringify({ id: u.id, language_code: u.lang }) };
    await app.inject({ method: "POST", url: "/me/accept-terms", headers, payload: {} });
    await app.inject({ method: "POST", url: "/internal/phone", headers, payload: { phone: `+99890${String(u.id).slice(-7)}` } });
  }
}
