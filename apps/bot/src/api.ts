import type { CheckResult, Lang } from "@ishonch/shared";

export interface TgUser {
  id: number;
  language_code?: string;
}

export interface Me {
  id: string;
  language: Lang;
  role: string;
  acceptedTerms: boolean;
  checks: { perDay: number; remaining: number };
}

export type CardButton = { text: string; url: string } | { text: string; callbackData: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ImageFile {
  data: Uint8Array<ArrayBuffer>;
  mediaType: string;
}

/** Thin client for the internal API; the bot never touches the database directly. */
export class ApiClient {
  constructor(
    private baseUrl: string,
    private internalToken: string,
  ) {}

  private headers(user: TgUser): Record<string, string> {
    return {
      authorization: `Internal ${this.internalToken}`,
      "x-telegram-user": JSON.stringify({ id: user.id, language_code: user.language_code }),
    };
  }

  private async request<T>(path: string, init: RequestInit & { user?: TgUser }): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.user ? this.headers(init.user) : {}), ...(init.headers as Record<string, string>) },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!res.ok) throw new ApiError(res.status, body.error ?? "error", body.message ?? res.statusText);
    return body as T;
  }

  me(user: TgUser) {
    return this.request<Me>("/me", { user });
  }

  setLanguage(user: TgUser, language: Lang) {
    return this.request("/me", {
      method: "PATCH",
      user,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language }),
    });
  }

  checkText(user: TgUser, text: string, lang: Lang) {
    return this.request<CheckResult>("/checks", {
      method: "POST",
      user,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, lang }),
    });
  }

  checkImages(user: TgUser, images: ImageFile[], text: string | undefined, lang: Lang) {
    const form = new FormData();
    form.append("lang", lang);
    if (text) form.append("text", text);
    images.forEach((img, i) =>
      form.append("images", new Blob([img.data], { type: img.mediaType }), `screenshot-${i}.jpg`),
    );
    return this.request<CheckResult>("/checks", { method: "POST", user, body: form });
  }

  setPhone(user: TgUser, phone: string) {
    return this.request("/internal/phone", {
      method: "POST",
      user,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    });
  }

  linkChannel(user: TgUser, telegramChannelId: number, title: string) {
    return this.request<{ id: number }>("/internal/channels", {
      method: "POST",
      user,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ telegramChannelId, title }),
    });
  }

  unlinkChannel(user: TgUser, telegramChannelId: number) {
    return this.request<{ title: string | null }>(`/internal/channels/${telegramChannelId}`, { method: "DELETE", user });
  }

  sendConversationMessage(user: TgUser, conversationId: string, text: string) {
    return this.request(`/internal/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: "POST",
      user,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  // ---- stage 4: inline buttons (the API checks who may do what) ----
  orderAction(user: TgUser, orderId: string, action: "confirm" | "decline") {
    return this.request<{ status: string }>(`/orders/${encodeURIComponent(orderId)}/${action}`, { method: "POST", user });
  }

  suggestReplies(user: TgUser, conversationId: string) {
    return this.request<{ items: string[] }>(`/internal/conversations/${encodeURIComponent(conversationId)}/suggestions`, { method: "POST", user });
  }

  sendSuggestion(user: TgUser, conversationId: string, index: number) {
    return this.request<{ ok: boolean; text: string }>(
      `/internal/conversations/${encodeURIComponent(conversationId)}/suggestions/${index}/send`,
      { method: "POST", user },
    );
  }

  offerAction(user: TgUser, offerId: string, action: "accept" | "decline") {
    return this.request<{ status: string }>(`/offers/${encodeURIComponent(offerId)}/${action}`, { method: "POST", user });
  }

  operatorStatus(user: TgUser, orderId: string, status: string) {
    return this.request<{ order: { status: string }; card: { text: string; buttons: CardButton[][] } }>(
      `/operator/orders/${encodeURIComponent(orderId)}/status`,
      { method: "POST", user, headers: { "content-type": "application/json" }, body: JSON.stringify({ status, wholeBundle: true }) },
    );
  }

  moderate(user: TgUser, listingId: string, decision: "approve" | "reject") {
    return this.request<{ status: string; title: string }>(`/admin/listings/${encodeURIComponent(listingId)}/moderate`, {
      method: "POST",
      user,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
  }

  renewListing(user: TgUser, listingId: string) {
    return this.request(`/listings/${encodeURIComponent(listingId)}/renew`, { method: "POST", user });
  }

  setPendingReply(user: TgUser, conversationId: string) {
    return this.request("/internal/pending-reply", {
      method: "POST",
      user,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
  }

  takePendingReply(user: TgUser) {
    return this.request<{ conversationId?: string; expired?: boolean }>("/internal/pending-reply/take", { method: "POST", user });
  }

  getCheck(id: string) {
    return this.request<CheckResult>(`/checks/${encodeURIComponent(id)}`, {});
  }
}
