import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import type { Page } from "@playwright/test";

export const API = "http://localhost:3100";
export const BOT_TOKEN = "123456:DEV"; // the dev mock server's default
export const INTERNAL = "dev-internal-token";
/** Users of the demo catalog (apps/api/test/dev-seed-catalog.ts) and test users. */
export const SHOP_OWNER = 999_000_001;
export const PRIVATE_SELLER = 999_000_002;
export const BUYER = 777_000_111;
export const OPERATOR = 777_000_222;

/** Signed Telegram initData, exactly as Telegram builds it (HMAC with the bot token). */
export function initData(id: number, lang = "ru") {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "e2e",
    user: JSON.stringify({ id, first_name: "E2E", language_code: lang }),
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

/** Calls the API as the bot does (internal token + the user's Telegram id). */
export async function asBot<T = unknown>(method: string, path: string, user: number, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Internal ${INTERNAL}`,
      "x-telegram-user": JSON.stringify({ id: user, language_code: "ru" }),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** Fresh demo catalog + users who accepted the terms and shared a phone. */
export async function resetDemo() {
  execSync("pnpm --filter @ishonch/api dev:seed-catalog", { stdio: "ignore", cwd: new URL("../../..", import.meta.url).pathname });
  for (const u of [BUYER, PRIVATE_SELLER, SHOP_OWNER, OPERATOR]) {
    await asBot("POST", "/me/accept-terms", u, {});
    await asBot("POST", "/internal/phone", u, { phone: `+99890${String(u).slice(-7)}` }).catch(() => undefined);
  }
}

export interface DemoItem {
  listing: { id: string; titleRu: string; price: number; seller: { id: string; shop: { name: string } | null } };
}
export async function catalog(): Promise<DemoItem[]> {
  return ((await (await fetch(`${API}/catalog`)).json()) as { items: DemoItem[] }).items;
}

/** Opens the Mini App as `user` (outside Telegram the app takes initData from the URL). */
export async function open(page: Page, user: number, query = "") {
  await page.goto(`/?initData=${encodeURIComponent(initData(user))}${query ? `&${query}` : ""}`);
}
