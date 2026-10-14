import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Message } from "grammy/types";
import { normalizeLang, t, type CheckResult, type Lang } from "@ishonch/shared";
import { ApiClient, ApiError, type ImageFile, type TgUser } from "./api.js";
import { formatCheck } from "./format.js";

export interface BotConfig {
  token: string;
  miniAppUrl: string;
  /** Telegram username of the bot, used for share deep links. */
  username?: string;
}

const MAX_IMAGES = 5;
/** How long the bot waits for the reply text after "Reply" was pressed. */
export const REPLY_WINDOW_MS = 15 * 60_000;
const ALBUM_WAIT_MS = 1200;

function tgUser(ctx: Context): TgUser | null {
  return ctx.from ? { id: ctx.from.id, language_code: ctx.from.language_code } : null;
}

export function createBot(cfg: BotConfig, api: ApiClient) {
  const bot = new Bot(cfg.token);

  // Staff groups (operators, moderators) only use inline buttons; never treat group chatter as listings to check.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private" && ctx.chat.type !== "channel" && !ctx.callbackQuery) return;
    await next();
  });

  async function langOf(user: TgUser): Promise<Lang> {
    try {
      return (await api.me(user)).language;
    } catch {
      return normalizeLang(user.language_code);
    }
  }

  function resultKeyboard(lang: Lang, check: CheckResult) {
    const kb = new InlineKeyboard().webApp(
      t(lang, "bot.find_similar"),
      `${cfg.miniAppUrl}?startapp=similar_${check.id}#/catalog`,
    );
    const username = cfg.username ?? (bot.isInited() ? bot.botInfo.username : undefined);
    if (username) {
      const link = `https://t.me/${username}?start=check_${check.id}`;
      kb.row().url(t(lang, "bot.share"), `https://t.me/share/url?url=${encodeURIComponent(link)}`);
    }
    return kb;
  }

  async function runCheck(ctx: Context, user: TgUser, fn: (lang: Lang) => Promise<CheckResult>) {
    const lang = await langOf(user);
    const progress = await ctx.reply(t(lang, "bot.processing"));
    try {
      const check = await fn(lang);
      await ctx.api.editMessageText(progress.chat.id, progress.message_id, formatCheck(check), {
        parse_mode: "HTML",
        reply_markup: resultKeyboard(lang, check),
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : t(lang, "common.error");
      if (!(err instanceof ApiError)) console.error("check failed", err);
      await ctx.api.editMessageText(progress.chat.id, progress.message_id, message);
    }
  }

  async function download(fileId: string): Promise<ImageFile> {
    const file = await bot.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${cfg.token}/${file.file_path}`);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const path = file.file_path ?? "";
    const mediaType = path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
    return { data: new Uint8Array(await res.arrayBuffer()), mediaType };
  }

  function imageFileId(msg: Message): string | null {
    if (msg.photo?.length) return msg.photo[msg.photo.length - 1]!.file_id;
    if (msg.document?.mime_type?.startsWith("image/")) return msg.document.file_id;
    return null;
  }

  async function checkImages(ctx: Context, messages: Message[]) {
    const user = tgUser(ctx);
    if (!user) return;
    const ids = messages.map(imageFileId).filter((x): x is string => x !== null);
    const caption = messages.map((m) => m.caption).filter(Boolean).join("\n") || undefined;
    if (ids.length > MAX_IMAGES) {
      await ctx.reply(t(await langOf(user), "check.too_many_images"));
      return;
    }
    await runCheck(ctx, user, async (lang) => api.checkImages(user, await Promise.all(ids.map(download)), caption, lang));
  }

  // ---- commands ----
  bot.command("start", async (ctx) => {
    const user = tgUser(ctx);
    if (!user) return;
    const payload = ctx.match?.trim();
    const lang = await langOf(user);

    if (payload?.startsWith("check_")) {
      try {
        const check = await api.getCheck(payload.slice("check_".length));
        await ctx.reply(formatCheck({ ...check, remainingToday: null }), { parse_mode: "HTML" });
      } catch {
        await ctx.reply(t(lang, "common.error"));
      }
      return;
    }

    await ctx.reply(t(lang, "bot.welcome"), {
      reply_markup: new InlineKeyboard()
        .webApp(t(lang, "bot.open_app"), cfg.miniAppUrl)
        .row()
        .text("🇺🇿 O'zbekcha", "lang:uz")
        .text("🇷🇺 Русский", "lang:ru"),
    });
  });

  bot.command("sell", async (ctx) => {
    const user = tgUser(ctx);
    if (!user) return;
    const lang = await langOf(user);
    await ctx.reply(t(lang, "home.sell.desc_ready"), {
      reply_markup: new InlineKeyboard().webApp(t(lang, "home.sell.title"), `${cfg.miniAppUrl}?screen=sell`),
    });
  });

  // Staff panel (admins, operators). Not in the command menu; the Mini App checks the role.
  bot.command("admin", async (ctx) => {
    const user = tgUser(ctx);
    if (!user) return;
    const me = await api.me(user).catch(() => null);
    if (!me || (me.role !== "admin" && me.role !== "operator")) return ctx.reply(t(me?.language ?? "ru", "bot.help"));
    await ctx.reply(me.role === "admin" ? "🛠 Админка Ishonch" : "🚚 Заказы на доставку", {
      reply_markup: new InlineKeyboard().webApp("Открыть", `${cfg.miniAppUrl}?screen=admin`),
    });
  });

  bot.command("help", async (ctx) => {
    const user = tgUser(ctx);
    if (user) await ctx.reply(t(await langOf(user), "bot.help"));
  });

  bot.command("lang", async (ctx) => {
    await ctx.reply(t("uz", "bot.choose_language"), {
      reply_markup: new InlineKeyboard().text("🇺🇿 O'zbekcha", "lang:uz").text("🇷🇺 Русский", "lang:ru"),
    });
  });

  bot.callbackQuery(/^lang:(uz|ru)$/, async (ctx) => {
    const user = tgUser(ctx);
    const lang = ctx.match[1] as Lang;
    if (user) await api.setLanguage(user, lang);
    await ctx.answerCallbackQuery({ text: t(lang, "bot.language_set") });
    await ctx.reply(t(lang, "bot.help"), {
      reply_markup: new InlineKeyboard().webApp(t(lang, "bot.open_app"), cfg.miniAppUrl),
    });
  });

  // ---- masked buyer ↔ seller chat: "Reply" button → next text message is relayed ----
  const pendingReplies = new Map<number, { conversationId: string; at: number }>();

  bot.callbackQuery(/^reply:([0-9a-f-]{36})$/, async (ctx) => {
    const user = tgUser(ctx);
    if (!user) return;
    pendingReplies.set(user.id, { conversationId: ctx.match[1]!, at: Date.now() });
    const lang = await langOf(user);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "bot.write_reply"), { reply_markup: { force_reply: true } });
  });

  async function relayReply(ctx: Context, user: TgUser, text: string): Promise<boolean> {
    const pending = pendingReplies.get(user.id);
    if (!pending) return false;
    pendingReplies.delete(user.id);
    if (Date.now() - pending.at > REPLY_WINDOW_MS) return false;
    const lang = await langOf(user);
    try {
      await api.sendConversationMessage(user, pending.conversationId, text);
      await ctx.reply(t(lang, "bot.reply_sent"));
    } catch (err) {
      await ctx.reply(err instanceof ApiError ? err.message : t(lang, "common.error"));
    }
    return true;
  }

  // ---- stage 4: delivery orders, operators, moderators, renewals ----
  async function buttonAction(ctx: Context, run: (user: TgUser, lang: Lang) => Promise<string>) {
    const user = tgUser(ctx);
    if (!user) return;
    const lang = await langOf(user);
    try {
      const text = await run(user, lang);
      await ctx.answerCallbackQuery({ text });
    } catch (err) {
      await ctx.answerCallbackQuery({
        text: err instanceof ApiError ? err.message.slice(0, 190) : t(lang, "common.error"),
        show_alert: true,
      });
    }
  }

  // Seller: confirm / decline a buyer's delivery request.
  bot.callbackQuery(/^order:(confirm|decline):([0-9a-f-]{36})$/, (ctx) =>
    buttonAction(ctx, async (user, lang) => {
      const action = ctx.match[1] as "confirm" | "decline";
      const order = await api.orderAction(user, ctx.match[2]!, action);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      return t(lang, `order.status.${order.status}` as Parameters<typeof t>[1]);
    }),
  );

  // Operators' chat: move the order to the next status; the card is re-rendered by the API.
  bot.callbackQuery(/^op:([a-z_]+):([0-9a-f-]{36})$/, (ctx) =>
    buttonAction(ctx, async (user) => {
      const res = await api.operatorStatus(user, ctx.match[2]!, ctx.match[1]!);
      const keyboard = new InlineKeyboard();
      for (const row of res.card.buttons) {
        for (const b of row) {
          if ("url" in b) keyboard.url(b.text, b.url);
          else keyboard.text(b.text, b.callbackData);
        }
        keyboard.row();
      }
      await ctx.editMessageText(res.card.text, { reply_markup: keyboard }).catch(() => undefined);
      return t("ru", `order.status.${res.order.status}` as Parameters<typeof t>[1]);
    }),
  );

  // Moderators' chat: approve / reject a pending listing.
  bot.callbackQuery(/^mod:(approve|reject):([0-9a-f-]{36})$/, (ctx) =>
    buttonAction(ctx, async (user) => {
      const res = await api.moderate(user, ctx.match[2]!, ctx.match[1] as "approve" | "reject");
      const verdict = res.status === "active" ? "✅ Одобрено" : "⛔️ Отклонено";
      const by = ctx.from?.username ? ` (@${ctx.from.username})` : "";
      const original = ctx.callbackQuery.message && "text" in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : res.title;
      await ctx.editMessageText(`${original}\n\n${verdict}${by}`).catch(() => undefined);
      return verdict;
    }),
  );

  // Seller: renew a listing from the expiry reminder.
  bot.callbackQuery(/^renew:([0-9a-f-]{36})$/, (ctx) =>
    buttonAction(ctx, async (user, lang) => {
      await api.renewListing(user, ctx.match[1]!);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      return t(lang, "expiry.renewed");
    }),
  );

  // ---- module D: seller's channel (bot added/removed as channel admin) ----
  bot.on("my_chat_member", async (ctx) => {
    const upd = ctx.myChatMember;
    if (upd.chat.type !== "channel") return;
    const user: TgUser = { id: upd.from.id, language_code: upd.from.language_code };
    const lang = await langOf(user);
    const title = upd.chat.title;
    const member = upd.new_chat_member;
    const notify = (text: string) => ctx.api.sendMessage(user.id, text).catch(() => undefined);

    if (member.status === "administrator") {
      if (!member.can_post_messages) return notify(t(lang, "bot.channel_need_post_rights", { title }));
      await api.linkChannel(user, upd.chat.id, title);
      return notify(t(lang, "bot.channel_linked", { title }));
    }
    if (member.status === "left" || member.status === "kicked" || member.status === "member") {
      // The channel belongs to whoever linked it; removal by any admin unlinks it.
      await api.unlinkChannel(user, upd.chat.id).catch(() => undefined);
      return notify(t(lang, "bot.channel_unlinked", { title }));
    }
  });

  // ---- phone shared via Telegram (requestPhoneAccess in the Mini App, or the contact button) ----
  bot.on("message:contact", async (ctx) => {
    const user = tgUser(ctx);
    if (!user) return;
    const lang = await langOf(user);
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) return ctx.reply(t(lang, "bot.phone_not_own"));
    await api.setPhone(user, c.phone_number);
    await ctx.reply(t(lang, "bot.phone_saved"), {
      reply_markup: new InlineKeyboard().webApp(t(lang, "bot.open_app"), `${cfg.miniAppUrl}?screen=sell`),
    });
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const user = tgUser(ctx);
    if (!user) return;
    const lang = await langOf(user);
    await ctx.reply(t(lang, "bot.voice_use_app"), {
      reply_markup: new InlineKeyboard().webApp(t(lang, "home.sell.title"), `${cfg.miniAppUrl}?screen=sell`),
    });
  });

  // ---- module B: listing check ----
  const albums = new Map<string, { ctx: Context; messages: Message[]; timer: NodeJS.Timeout }>();

  bot.on(["message:photo", "message:document"], async (ctx) => {
    if (!imageFileId(ctx.message)) return;
    const groupId = ctx.message.media_group_id;
    if (!groupId) return checkImages(ctx, [ctx.message]);

    const key = `${ctx.chat.id}:${groupId}`;
    const existing = albums.get(key);
    if (existing) {
      existing.messages.push(ctx.message);
      clearTimeout(existing.timer);
    }
    const entry = existing ?? { ctx, messages: [ctx.message], timer: undefined as unknown as NodeJS.Timeout };
    entry.timer = setTimeout(() => {
      albums.delete(key);
      void checkImages(entry.ctx, entry.messages);
    }, ALBUM_WAIT_MS);
    albums.set(key, entry);
  });

  bot.on("message:text", async (ctx) => {
    const user = tgUser(ctx);
    if (!user || ctx.message.text.startsWith("/")) return;
    if (await relayReply(ctx, user, ctx.message.text)) return;
    await runCheck(ctx, user, (lang) => api.checkText(user, ctx.message.text, lang));
  });

  bot.on("message", async (ctx) => {
    const user = tgUser(ctx);
    if (user) await ctx.reply(t(await langOf(user), "bot.unsupported"));
  });

  bot.catch((err) => console.error("bot error", err.error));
  return bot;
}
