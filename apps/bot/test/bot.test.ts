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
  pending = new Map<number, { conversationId: string; expired?: boolean }>();
  async setPendingReply(u: { id: number }, conversationId: string) {
    this.calls.push(`pending:${u.id}:${conversationId}`);
    this.pending.set(u.id, { conversationId });
    return {};
  }
  async takePendingReply(u: { id: number }) {
    const p = this.pending.get(u.id);
    this.pending.delete(u.id);
    return p ? (p.expired ? { expired: true } : { conversationId: p.conversationId }) : {};
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
  async suggestReplies(u: { id: number }, id: string) {
    this.calls.push(`sugg:${u.id}:${id}`);
    return { items: ["Да, в продаже.", "Можно доставку с осмотром.", "Цена окончательная."] };
  }
  async sendSuggestion(u: { id: number }, id: string, index: number) {
    this.calls.push(`sr:${u.id}:${id}:${index}`);
    return { ok: true, text: "Можно доставку с осмотром." };
  }
  async offerAction(u: { id: number }, id: string, action: string) {
    this.calls.push(`offer:${u.id}:${action}:${id}`);
    return { status: action === "accept" ? "accepted" : "declined" };
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
  async blockConversation(u: { id: number }, id: string) {
    this.calls.push(`block:${u.id}:${id}`);
    return { ok: true };
  }
  async reportConversation(u: { id: number }, id: string, reason: string) {
    this.calls.push(`report:${u.id}:${id}:${reason}`);
    return { ok: true };
  }
  async meetingAction(u: { id: number }, id: string, action: string) {
    this.calls.push(`meet:${u.id}:${id}:${action}`);
    return { status: action === "accept" ? "accepted" : "declined" };
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
    await bot.idle();
    const reply = sent.find((s) => s.method === "sendMessage")!;
    expect(reply.payload.text).toMatch(/Ishonch/);
    const kb = JSON.stringify(reply.payload.reply_markup);
    expect(kb).toContain("https://app.example");
    expect(kb).toContain("lang:uz");
  });

  it("text listing -> processing message edited into the check card with share button", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(msg("iPhone 13 за 3,5 млн, предоплата"));
    await bot.idle();
    expect(api.calls).toContain("checkText:iPhone 13 за 3,5 млн, предоплата");
    const edit = sent.find((s) => s.method === "editMessageText")!;
    expect(edit.payload.parse_mode).toBe("HTML");
    expect(String(edit.payload.text)).toContain("высокий");
    expect(JSON.stringify(edit.payload.reply_markup)).toContain("start%3Dcheck_11111111");
  });

  it("link-only message gets the API's explanation", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(msg("https://olx.uz/d/abc"));
    await bot.idle();
    const edit = sent.find((s) => s.method === "editMessageText")!;
    expect(edit.payload.text).toBe("Пришлите скриншот");
  });

  it("/start check_<id> renders a shared check", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(msg(`/start check_${check.id}`));
    await bot.idle();
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
    await bot.idle();
    expect(api.calls).toContain("link:5:-100555:Shop channel");
    expect(sent.find((s) => s.method === "sendMessage")!.payload.text).toContain("привязан");
  });

  it("asks for posting rights instead of linking", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(chatMember("administrator", false));
    await bot.idle();
    expect(api.calls.some((c) => c.startsWith("link"))).toBe(false);
    expect(String(sent.find((s) => s.method === "sendMessage")!.payload.text)).toContain("право публиковать");
  });

  it("unlinks when the bot is removed", async () => {
    const { api, bot } = setup();
    await bot.handleUpdate(chatMember("left"));
    await bot.idle();
    expect(api.calls).toContain("unlink:-100555");
  });

  it("saves the user's own phone, rejects someone else's contact", async () => {
    const { api, bot, sent } = setup();
    const contact = (userId: number): Update => ({
      update_id: 3,
      message: { message_id: 2, date: 0, chat: { id: 5, type: "private", first_name: "A" }, from, contact: { phone_number: "998901234567", first_name: "A", user_id: userId } },
    });
    await bot.handleUpdate(contact(999));
    await bot.idle();
    expect(api.calls.some((c) => c.startsWith("setPhone"))).toBe(false);
    await bot.handleUpdate(contact(5));
    await bot.idle();
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
    await bot.idle();
    expect(String(sent.find((s) => s.method === "sendMessage")!.payload.text)).toContain("Напишите ответ");
    await bot.handleUpdate(msg("Да, ещё продаю"));
    await bot.idle();
    expect(api.calls).toContain(`relay:${conv}:Да, ещё продаю`);
    expect(api.calls.some((c) => c.startsWith("checkText"))).toBe(false);
    expect(sent.at(-1)!.payload.text).toBe("✅ Отправлено");

    // The following message is a normal listing check again.
    await bot.handleUpdate(msg("iPhone 13 за 3 млн"));
    await bot.idle();
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
    await bot.idle();
    expect(api.calls).toContain(`order:5:confirm:${ORDER}`);
    expect(sent.some((s) => s.method === "editMessageReplyMarkup")).toBe(true);
    const answer = sent.find((s) => s.method === "answerCallbackQuery")!;
    expect(answer.payload.text).toContain("Подтверждён");
  });

  it("reply drafts: the seller sees three numbered options and sends one with a tap", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`sugg:${ORDER}`));
    await bot.idle();
    expect(api.calls).toContain(`sugg:5:${ORDER}`);
    const msg = sent.find((s) => s.method === "sendMessage")!;
    expect(msg.payload.text).toContain("2. Можно доставку с осмотром.");
    const kb = JSON.stringify(msg.payload.reply_markup);
    expect(kb).toContain(`sr:${ORDER}:2`);
    expect(kb).toContain(`reply:${ORDER}`);

    await bot.handleUpdate(callback(`sr:${ORDER}:1`));
    await bot.idle();
    expect(api.calls).toContain(`sr:5:${ORDER}:1`);
    expect(sent.some((s) => s.method === "editMessageText" && String(s.payload.text).includes("Можно доставку"))).toBe(true);
  });

  it("seller answers a price offer from the DM; buttons are removed", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`offer:accept:${ORDER}`));
    await bot.idle();
    expect(api.calls).toContain(`offer:5:accept:${ORDER}`);
    expect(sent.some((s) => s.method === "editMessageReplyMarkup")).toBe(true);
    expect(sent.find((s) => s.method === "answerCallbackQuery")!.payload.text).toBe("Вы согласились");
  });

  it("API refusals are shown as an alert", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(callback("order:decline:00000000-0000-0000-0000-000000000000"));
    await bot.idle();
    const answer = sent.find((s) => s.method === "answerCallbackQuery")!;
    expect(answer.payload).toMatchObject({ text: "Это действие уже недоступно для заказа", show_alert: true });
  });

  it("operator button in a group moves the order and re-renders the card", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`op:courier_assigned:${ORDER}`, { id: -100900, type: "supergroup" }));
    await bot.idle();
    expect(api.calls).toContain(`op:5:courier_assigned:${ORDER}`);
    const edit = sent.find((s) => s.method === "editMessageText")!;
    expect(edit.payload.text).toContain("courier_assigned");
    expect(JSON.stringify(edit.payload.reply_markup)).toContain(`op:picked_up:${ORDER}`);
  });

  it("moderator approves from the moderators' chat", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`mod:approve:${ORDER}`, { id: -100901, type: "supergroup" }));
    await bot.idle();
    expect(api.calls).toContain(`mod:5:approve:${ORDER}`);
    expect(String(sent.find((s) => s.method === "editMessageText")!.payload.text)).toContain("✅ Одобрено");
  });

  it("renew button extends the listing", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`renew:${ORDER}`));
    await bot.idle();
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
    await bot.idle();
    expect(api.calls.some((c) => c.startsWith("checkText"))).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("/admin", () => {
  it("opens the staff panel for admins and operators only", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(msg("/admin"));
    await bot.idle();
    expect(JSON.stringify(sent.at(-1)!.payload)).not.toContain("screen=admin");
    api.role = "operator";
    await bot.handleUpdate(msg("/admin"));
    await bot.idle();
    const reply = sent.at(-1)!;
    expect(reply.payload.text).toContain("Заказы на доставку");
    expect(JSON.stringify(reply.payload.reply_markup)).toContain("https://app.example?screen=admin");
  });
});

describe("review fixes", () => {
  it("a slow check does not block other users (runs in the background)", async () => {
    const { api, bot } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = api.checkText.bind(api);
    api.checkText = async (...args: Parameters<typeof orig>) => (await gate, orig(...args));
    await bot.handleUpdate(msg("iPhone 13 за 3,5 млн"));
    await bot.handleUpdate(msg("/help")); // handled while the check is still waiting
    expect(api.calls).toContain("me");
    release();
    await bot.idle();
    expect(api.calls).toContain("checkText:iPhone 13 за 3,5 млн");
  });

  it("unknown buttons stop the spinner", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate(callback("stale:button"));
    expect(sent.some((s) => s.method === "answerCallbackQuery")).toBe(true);
  });
});

describe("Reply button state lives in the API", () => {
  it("Reply → next text is relayed, not checked; an expired window says so", async () => {
    const { api, bot, sent } = setup();
    await bot.handleUpdate(callback(`reply:${ORDER}`));
    expect(api.calls).toContain(`pending:5:${ORDER}`);
    await bot.handleUpdate(msg("Да, ещё продаю"));
    await bot.idle();
    expect(api.calls).toContain(`relay:${ORDER}:Да, ещё продаю`);
    expect(api.calls.some((c) => c.startsWith("checkText"))).toBe(false);

    api.pending.set(5, { conversationId: ORDER, expired: true });
    await bot.handleUpdate(msg("поздний ответ"));
    await bot.idle();
    expect(String(sent.at(-1)!.payload.text)).toContain("истекло");
    expect(api.calls.some((c) => c.startsWith("checkText:поздний"))).toBe(false);
  });

  it("meeting request buttons: the seller accepts in the bot", async () => {
    const { api, bot, sent } = setup();
    const id = "22222222-2222-2222-2222-222222222222";
    await bot.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "cb1",
        from: { id: 5, is_bot: false, first_name: "A", language_code: "ru" },
        chat_instance: "1",
        data: `meet:accept:${id}`,
        message: { message_id: 3, date: 0, chat: { id: 5, type: "private", first_name: "A" }, text: "🤝" },
      },
    });
    await bot.idle();
    expect(api.calls).toContain(`meet:5:${id}:accept`);
    expect(sent.some((s) => s.method === "answerCallbackQuery" && String(s.payload.text).includes("Договорились"))).toBe(true);
  });

  it("chat safety: block and report the other side from the relayed message", async () => {
    const { api, bot, sent } = setup();
    const id = "33333333-3333-3333-3333-333333333333";
    const cb = (data: string, n: number): Update => ({
      update_id: n,
      callback_query: {
        id: `cb${n}`,
        from: { id: 5, is_bot: false, first_name: "A", language_code: "ru" },
        chat_instance: "1",
        data,
        message: { message_id: 3, date: 0, chat: { id: 5, type: "private", first_name: "A" }, text: "💬" },
      },
    });
    await bot.handleUpdate(cb(`blk:${id}`, 10));
    await bot.idle();
    expect(api.calls).toContain(`block:5:${id}`);
    expect(sent.some((s) => s.method === "sendMessage" && String(s.payload.text).includes("заблокирован"))).toBe(true);

    await bot.handleUpdate(cb(`rep:${id}`, 11));
    await bot.idle();
    const ask = sent.filter((s) => s.method === "sendMessage").at(-1)!;
    expect(JSON.stringify(ask.payload.reply_markup)).toContain(`rep:${id}:prepayment`);
    await bot.handleUpdate(cb(`rep:${id}:prepayment`, 12));
    await bot.idle();
    expect(api.calls).toContain(`report:5:${id}:prepayment`);
  });
});
