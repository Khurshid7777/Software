import { Api, InputFile } from "grammy";

export interface ChannelPost {
  photo: Buffer | null;
  /** Telegram HTML caption, ≤ 1024 chars. */
  caption: string;
  button: { text: string; url: string };
}

/** Posts listings to sellers' Telegram channels (the bot must be a channel admin). */
export interface ChannelPublisher {
  post(channelId: number, post: ChannelPost): Promise<{ messageId: number }>;
  /** Deep link that opens the Mini App with a start parameter. */
  miniAppLink(startParam: string): Promise<string>;
}

export type NotifyButton = { text: string; url: string } | { text: string; callbackData: string };

/** Direct messages from the bot to a user (masked chat, saved-search alerts). */
export interface Notifier {
  send(telegramUserId: number, text: string, buttons?: NotifyButton[][]): Promise<void>;
}

export class BotApiPublisher implements ChannelPublisher, Notifier {
  private api: Api;
  private username: Promise<string> | null = null;

  constructor(
    token: string,
    private miniAppLinkBase?: string,
  ) {
    // A hung Telegram call must not outlive a job's lock (jobs/queue.ts) and run the job twice.
    this.api = new Api(token, { timeoutSeconds: 30 });
  }

  async post(channelId: number, post: ChannelPost) {
    const reply_markup = { inline_keyboard: [[{ text: post.button.text, url: post.button.url }]] };
    const msg = post.photo
      ? await this.api.sendPhoto(channelId, new InputFile(post.photo, "photo.jpg"), {
          caption: post.caption,
          parse_mode: "HTML",
          reply_markup,
        })
      : await this.api.sendMessage(channelId, post.caption, { parse_mode: "HTML", reply_markup });
    return { messageId: msg.message_id };
  }

  async send(telegramUserId: number, text: string, buttons: NotifyButton[][] = []) {
    await this.api.sendMessage(telegramUserId, text, {
      link_preview_options: { is_disabled: true },
      reply_markup: buttons.length
        ? {
            inline_keyboard: buttons.map((row) =>
              row.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData })),
            ),
          }
        : undefined,
    });
  }

  async miniAppLink(startParam: string) {
    if (this.miniAppLinkBase) return `${this.miniAppLinkBase}?startapp=${encodeURIComponent(startParam)}`;
    // A failed getMe is not cached: the next call tries again instead of failing until a restart.
    this.username ??= this.api.getMe().then(
      (me) => me.username,
      (err) => {
        this.username = null;
        throw err;
      },
    );
    return `https://t.me/${await this.username}?startapp=${encodeURIComponent(startParam)}`;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Builds a caption that always fits Telegram's 1024-char photo caption limit. */
export function buildCaption(parts: { title: string; price: string | null; meta: string[]; description: string; footer: string }) {
  const head = [`<b>${esc(parts.title)}</b>`, parts.price ? `💰 <b>${esc(parts.price)}</b>` : null, ...parts.meta.map(esc)]
    .filter(Boolean)
    .join("\n");
  const footer = esc(parts.footer);
  const room = 1024 - head.length - footer.length - 4;
  // Truncate the raw text (not the escaped one) so we never cut an HTML entity in half.
  let raw = parts.description;
  let truncated = false;
  while (raw && esc(raw).length + (truncated ? 1 : 0) > room) {
    raw = raw.slice(0, Math.max(0, raw.length - 10)).trimEnd();
    truncated = true;
  }
  const desc = esc(raw) + (truncated ? "…" : "");
  return [head, desc, footer].filter(Boolean).join("\n\n");
}
