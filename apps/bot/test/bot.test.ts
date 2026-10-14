import { describe, expect, it } from "vitest";
import type { Update } from "grammy/types";
import type { CheckResult } from "@ishonch/shared";
import { ApiClient, ApiError } from "../src/api.js";
import { createBot } from "../src/bot.js";
import { formatCheck } from "../src/format.js";

const check: CheckResult = {
  id: "11111111-1111-1111-1111-111111111111",
  lang: "ru",
  createdAt: new Date().toISOString(),
  title: "Apple iPhone 13 <128>",
  category: "smartphone",
  price: {
    verdict: "below",
    diffPct: -40,
    priceUzs: 3_500_000,
    range: { min: 5_200_000, median: 5_800_000, max: 6_500_000 },
    source: "reference",
    approximate: false,
  },
  risk: { score: 75, level: "high", flags: [{ id: "prepayment", weight: 30 }], aiAdjustment: 0 },
  redFlags: ["Просят предоплату / перевод на карту / задаток"],
  pros: ["Свежая модель"],
  cons: ["Подозрительно дёшево"],
  questions: ["1?", "2?", "3?", "4?", "5?"],
  checklist: ["IMEI"],
  remainingToday: 4,
};

describe("formatCheck", () => {
  it("renders all blocks and escapes HTML", () => {
    const html = formatCheck(check);
    expect(html).toContain("Apple iPhone 13 &lt;128&gt;");
    expect(html).toContain("ниже рынка на 40%");
    expect(html).toContain("🔴");
    expect(html).toContain("высокий");
    expect(html).toContain("5. 5?");
    expect(html).toContain("Это оценка AI, а не гарантия");
    expect(html).toContain("3 500 000 UZS");
  });

  it("uzbek card", () => {
    const html = formatCheck({ ...check, lang: "uz" });
    expect(html).toContain("bozordan 40% arzon");
    expect(html).toContain("Bu AI bahosi, kafolat emas");
  });
});

class FakeApi {
  calls: string[] = [];
  role = "buyer";
  async me() {
    this.calls.push("me");
    return { id: "u", language: "ru" as const, role: this.role, acceptedTerms: true, checks: { perDay: 5, remaining: 5 } };
  }
  async setLanguage() {
    this.calls.push("setLanguage");
    return {};
  }
  async checkText(_u: unknown, text: string) {
    this.calls.push(`checkText:${text}`);
    if (text.includes("olx.uz")) throw new ApiError(422, "link_not_supported", "Пришлите скриншот");
    return check;
  }
  async checkImages() {
    return check;
  }
  async getCheck() {
    return check;
  }
  async setPhone(_u: unknown, phone: string) {
    this.calls.push(`setPhone:${phone}`);
    return {};
  }
  async linkChannel(u: { id: number }, id: number, title: string) {
    this.calls.push(`link:${u.id}:${id}:${title}`);
    return { id: 1 };
  }
  async sendConversationMessage(_u: unknown, conv: string, text: string) {
    this.calls.push(`relay:${conv}:${text}`);
    return {};
  }
  async unlinkChannel(_u: unknown, id: number) {
    this.calls.push(`unlink:${id}`);
    return { title: null };
  }
  async orderAction(u: { id: number }, id: string, action: string) {
    this.calls.push(`order:${u.id}:${action}:${id}`);
    if (id.startsWith("00000000")) throw new ApiError(409, "bad_state", "Это действие уже недоступно для заказа");
    return { status: action === "confirm" ? "confirmed" : "cancelled" };
  }
  async operatorStatus(u: { id: number }, id: string, status: string) {
    this.calls.push(`op:${u.id}:${status}:${id}`);
    return {
      order: { status },
      card: { text: `📦 Заказ — ${status}`, buttons: [[{ text: "📦 Курьер забрал", callbackData: `op:picked_up:${id}` }]] },
    };
  }
  async moderate(u: { id: number }, id: string, decision: string) {
    this.calls.push(`mod:${u.id}:${decision}:${id}`);
    return { status: decision === "approve" ? "active" : "rejected", title: "iPhone" };
  }
  async renewListing(u: { id: number }, id: string) {
    this.calls.push(`renew:${u.id}:${id}`);
    return {};
  }
}

function setup() {
  const api = new FakeApi();
  const bot = createBot({ token: "1:TEST", miniAppUrl: "https://app.example", username: "ishonch_bot" }, api as unknown as ApiClient);
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "Ishonch",
    username: "ishonch_bot",
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  } as typeof bot.botInfo;
  const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 10, chat: { id: 5, type: "private" }, date: 0 } } as never;
  });
  return { api, bot, sent };
}

const msg = (text: string): Update => ({
  update_id: 1,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 5, type: "private", first_name: "A" },
    from: { id: 5, is_bot: false, first_name: "A", language_code: "ru" },
    text,
    ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}),
  },
});

describe("bot handlers", () => {
  it("/start shows the Mini App button and language choice", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(msg("/start"));
    const reply = sent.find((s) => s.method === "sendMessage")!;
    expect(reply.payload.text).toMatch(/Ishonch/);
    const kb = JSON.stringify(reply.payload.reply_markup);
    expect(kb).toContain("https://app.example");
    expect(kb).toContain("lang:uz");
  });

  it("text listing -> processing message edited into the check card with share button", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(msg("iPhone 13 за 3,5 млн, предоплата"));
    expect(api.calls).toContain("checkText:iPhone 13 за 3,5 млн, предоплата");
    const edit = sent.find((s) => s.method === "editMessageText")!;
    expect(edit.payload.parse_mode).toBe("HTML");
    expect(String(edit.payload.text)).toContain("высокий");
    expect(JSON.stringify(edit.payload.reply_markup)).toContain("start%3Dcheck_11111111");
  });

  it("link-only message gets the API's explanation", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(msg("https://olx.uz/d/abc"));
    const edit = sent.find((s) => s.method === "editMessageText")!;
    expect(edit.payload.text).toBe("Пришлите скриншот");
  });

  it("/start check_<id> renders a shared check", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(msg(`/start check_${check.id}`));
    const reply = sent.find((s) => s.method === "sendMessage")!;
    expect(String(reply.payload.text)).toContain("iPhone 13");
  });
});

const from = { id: 5, is_bot: false, first_name: "A", language_code: "ru" };
const chatMember = (status: string, canPost = true): Update => ({
  update_id: 2,
  my_chat_member: {
    chat: { id: -100555, type: "channel", title: "Shop channel" },
    from,
    date: 0,
    old_chat_member: { status: "left", user: { id: 1, is_bot: true, first_name: "Ishonch" } },
    new_chat_member:
      status === "administrator"
        ? ({ status, user: { id: 1, is_bot: true, first_name: "Ishonch" }, can_post_messages: canPost } as never)
        : ({ status, user: { id: 1, is_bot: true, first_name: "Ishonch" } } as never),
  },
});

describe("seller handlers", () => {
  it("links a channel when the bot becomes an admin with posting rights", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(chatMember("administrator"));
    expect(api.calls).toContain("link:5:-100555:Shop channel");
    expect(sent.find((s) => s.method === "sendMessage")!.payload.text).toContain("привязан");
  });

  it("asks for posting rights instead of linking", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(chatMember("administrator", false));
    expect(api.calls.some((c) => c.startsWith("link"))).toBe(false);
    expect(String(sent.find((s) => s.method === "sendMessage")!.payload.text)).toContain("право публиковать");
  });

  it("unlinks when the bot is removed", async () => {
    const { api, bot } = setup();
    await bot.handleUpdate(chatMember("left"));
    expect(api.calls).toContain("unlink:-100555");
  });

  it("saves the user's own phone, rejects someone else's contact", async () => {
    const { api, bot, sent } = setup();
    const contact = (userId: number): Update => ({
      update_id: 3,
      message: { message_id: 2, date: 0, chat: { id: 5, type: "private", first_name: "A" }, from, contact: { phone_number: "998901234567", first_name: "A", user_id: userId } },
    });
    await bot.handleUpdate(contact(999));
    expect(api.calls.some((c) => c.startsWith("setPhone"))).toBe(false);
    await bot.handleUpdate(contact(5));
    expect(api.calls).toContain("setPhone:998901234567");
    expect(String(sent.at(-1)!.payload.text)).toContain("Номер сохранён");
  });

  it("voice message points to the sell screen instead of running a check", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate({
      update_id: 4,
      message: { message_id: 3, date: 0, chat: { id: 5, type: "private", first_name: "A" }, from, voice: { file_id: "v", file_unique_id: "v", duration: 3 } },
    });
    expect(api.calls.some((c) => c.startsWith("check"))).toBe(false);
    expect(JSON.stringify(sent.at(-1)!.payload.reply_markup)).toContain("screen=sell");
  });
});

describe("masked chat relay", () => {
  const conv = "22222222-2222-2222-2222-222222222222";
  const press = (data: string): Update => ({
    update_id: 9,
    callback_query: { id: "cb", from, chat_instance: "x", data, message: { message_id: 1, date: 0, chat: { id: 5, type: "private", first_name: "A" } } as never },
  });

  it("Reply button → next text goes to the conversation, not to a listing check", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(press(`reply:${conv}`));
    expect(String(sent.find((s) => s.method === "sendMessage")!.payload.text)).toContain("Напишите ответ");
    await bot.handleUpdate(msg("Да, ещё продаю"));
    expect(api.calls).toContain(`relay:${conv}:Да, ещё продаю`);
    expect(api.calls.some((c) => c.startsWith("checkText"))).toBe(false);
    expect(sent.at(-1)!.payload.text).toBe("✅ Отправлено");

    // The following message is a normal listing check again.
    await bot.handleUpdate(msg("iPhone 13 за 3 млн"));
    expect(api.calls).toContain("checkText:iPhone 13 за 3 млн");
  });
});

const ORDER = "22222222-2222-2222-2222-222222222222";
const callback = (data: string, chat: { id: number; type: string } = { id: 5, type: "private" }): Update => ({
  update_id: 9,
  callback_query: {
    id: "cb1",
    from,
    chat_instance: "x",
    data,
    message: { message_id: 7, date: 0, chat, text: "📦 Заказ — confirmed" } as never,
  },
});

describe("stage 4 buttons", () => {
  it("seller confirms an order from the DM; buttons are removed", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`order:confirm:${ORDER}`));
    expect(api.calls).toContain(`order:5:confirm:${ORDER}`);
    expect(sent.some((s) => s.method === "editMessageReplyMarkup")).toBe(true);
    const answer = sent.find((s) => s.method === "answerCallbackQuery")!;
    expect(answer.payload.text).toContain("Подтверждён");
  });

  it("API refusals are shown as an alert", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(callback("order:decline:00000000-0000-0000-0000-000000000000"));
    const answer = sent.find((s) => s.method === "answerCallbackQuery")!;
    expect(answer.payload).toMatchObject({ text: "Это действие уже недоступно для заказа", show_alert: true });
  });

  it("operator button in a group moves the order and re-renders the card", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`op:courier_assigned:${ORDER}`, { id: -100900, type: "supergroup" }));
    expect(api.calls).toContain(`op:5:courier_assigned:${ORDER}`);
    const edit = sent.find((s) => s.method === "editMessageText")!;
    expect(edit.payload.text).toContain("courier_assigned");
    expect(JSON.stringify(edit.payload.reply_markup)).toContain(`op:picked_up:${ORDER}`);
  });

  it("moderator approves from the moderators' chat", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`mod:approve:${ORDER}`, { id: -100901, type: "supergroup" }));
    expect(api.calls).toContain(`mod:5:approve:${ORDER}`);
    expect(String(sent.find((s) => s.method === "editMessageText")!.payload.text)).toContain("✅ Одобрено");
  });

  it("renew button extends the listing", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`renew:${ORDER}`));
    expect(api.calls).toContain(`renew:5:${ORDER}`);
    expect(sent.find((s) => s.method === "answerCallbackQuery")!.payload.text).toContain("30");
  });

  it("ignores ordinary messages in staff groups (no accidental checks)", async () => {
    const { api, bot, sent } = setup();
    const groupMsg: Update = {
      update_id: 10,
      message: { message_id: 1, date: 0, chat: { id: -100900, type: "supergroup", title: "Operators" }, from, text: "iPhone 13 за 3 млн" },
    };
    await bot.handleUpdate(groupMsg);
    expect(api.calls.some((c) => c.startsWith("checkText"))).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("/admin", () => {
  it("opens the staff panel for admins and operators only", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(msg("/admin"));
    expect(JSON.stringify(sent.at(-1)!.payload)).not.toContain("screen=admin");
    api.role = "operator";
    await bot.handleUpdate(msg("/admin"));
    const reply = sent.at(-1)!;
    expect(reply.payload.text).toContain("Заказы на доставку");
    expect(JSON.stringify(reply.payload.reply_markup)).toContain("https://app.example?screen=admin");
  });
});
