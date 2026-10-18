import { t } from "@ishonch/shared/client";
import type {
  MeetingDto,
  MeetingSpot,
  Condition,
  DisputeDto,
  DisputeReason,
  DisputeResolution,
  Inspection,
  Valuation,
  AssistantMessage,
  AssistantResponse,
  BundleQuote,
  CatalogFilters,
  CatalogItem,
  CatalogPage,
  CatalogSort,
  CheckResult,
  CompareResponse,
  ComplaintReason,
  CreateOrderInput,
  DeliveryMode,
  DeliveryQuote,
  LiftInfo,
  District,
  InspectionCheck,
  Lang,
  ListingDto,
  ListingInsights,
  ListingSeller,
  ListingStatus,
  TrustLevel,
  AdminMetrics,
  AdminSettings,
  CourierTariff,
  ModerationDecision,
  OfferDto,
  OrderStatus,
  OrderDto,
  ReviewDto,
  SellerRating,
} from "@ishonch/shared/client";

export interface SavedSearch {
  id: number;
  title: string;
  filters: CatalogFilters;
  createdAt: string;
}

export function filtersToQuery(f: CatalogFilters, sort?: CatalogSort, offset = 0) {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.category) p.set("category", f.category);
  if (f.priceMin) p.set("priceMin", String(f.priceMin));
  if (f.priceMax) p.set("priceMax", String(f.priceMax));
  if (f.conditions?.length) p.set("conditions", f.conditions.join(","));
  if (f.district) p.set("district", f.district);
  if (f.verifiedOnly) p.set("verifiedOnly", "true");
  if (f.goodGrade) p.set("goodGrade", "true");
  if (sort) p.set("sort", sort);
  if (offset) p.set("offset", String(offset));
  return p.toString();
}

const BASE = import.meta.env.VITE_API_URL ?? "/api";
/** Fired when the API rejects the launch data (expired initData): the app asks to reopen. */
export const SESSION_EXPIRED_EVENT = "ishonch:session-expired";

export interface Me {
  id: string;
  language: Lang;
  role: string;
  acceptedTerms: boolean;
  hasPhone: boolean;
  /** Optional notification types switched off (stage 20). */
  notifyOff?: string[];
  checks: { perDay: number; remaining: number };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public params: Record<string, string | number> = {},
  ) {
    super(message);
  }
}

export interface ShopInfo {
  shop: { id: string; name: string; marketLocation: string | null; hasPhoto: boolean; verified: boolean; bundle2Pct: number; bundle3Pct: number } | null;
  channels: Array<{ id: number; telegramChannelId: number; title: string }>;
}

export type ListingPatch = Partial<
  Pick<ListingDto, "titleRu" | "titleUz" | "descriptionRu" | "descriptionUz" | "price" | "condition" | "district" | "allowedDeliveryModes" | "feePayer" | "imei" | "checklist" | "acceptsTrade">
> & { autoDropFloor?: number | null };

/** Absolute URL for API-relative paths such as signed photo URLs. */
export const apiUrl = (path: string) => `${BASE}${path}`;
/** A signed photo URL at a smaller width (240 / 480 / 960) for cards and thumbnails. */
export const photoUrl = (path: string, width: 240 | 480 | 960) => `${BASE}${path}${path.includes("?") ? "&" : "?"}w=${width}`;

export interface ChatReport {
  id: number;
  reason: string;
  createdAt: string;
  listing: { id: string; title: string };
  reported: { id: string; telegramId: number; role: "buyer" | "seller"; banned: boolean; reports: number };
  messages: Array<{ from: "buyer" | "seller"; text: string; at: string }>;
}

export interface QueueItem {
  listing: ListingDto;
  moderation: { decision: string; source: string; reasons: Array<{ code: string; note: string }>; duplicates?: string[] } | null;
  openComplaints: number;
}
export interface ComplaintRow {
  id: number;
  listingId: string;
  reason: string;
  text: string | null;
  createdAt: string;
  listingTitle: string;
  listingStatus: string;
  sellerUserId: string;
}
export interface AdminUser {
  id: string;
  telegramId: number;
  role: string;
  createdAt: string;
  bannedAt: string | null;
  banReason: string | null;
  activeListings: number;
  /** Stage 19: missed meetings and chat reports against the user. */
  noShows: number;
  chatReports: number;
  rating: { avg: number | null; count: number };
}
export interface PriceRow {
  id: number;
  modelKey: string;
  priceMin: number;
  priceMedian: number;
  priceMax: number;
  source: string;
  updatedAt: string;
}
/** Admin queue row: the dispute plus what the decision needs. */
export type AdminDispute = DisputeDto & {
  title: string;
  listingId: string;
  itemPrice: number;
  deliveredAt: string | null;
  inspection: Inspection | null;
  inspectionPhotos: string[];
  buyerPhone: string | null;
  sellerPhone: string | null;
};

export type OperatorOrder = OrderDto & {
  contacts: { buyerPhone: string | null; sellerPhone: string | null; courierPhone: string | null };
  imei: string | null;
  category: string;
};

/** The UI language, for messages the API did not localize (rate limits, validation, network). */
let uiLang: Lang = "ru";
export const setApiLang = (l: Lang) => void (uiLang = l);

function fallbackMessage(status: number, code: string) {
  if (status === 429) return t(uiLang, "common.too_many");
  if (status === 404 || code === "not_found") return t(uiLang, "common.not_found");
  if (status === 400 || code === "bad_request") return t(uiLang, "common.bad_request");
  return t(uiLang, "common.error");
}

export function createApi(initData: string | null) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { ...(initData ? { authorization: `tma ${initData}` } : {}), ...init.headers },
      });
    } catch {
      throw new ApiError(0, "network", t(uiLang, "common.load_error"));
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && initData) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    if (!res.ok) {
      const code = typeof body.error === "string" ? body.error : "error";
      // Localized messages come from the API; anything else (rate limit, validation) gets a friendly text.
      const message = typeof body.message === "string" && body.message && res.status !== 429 && code !== "bad_request" ? body.message : fallbackMessage(res.status, code);
      throw new ApiError(res.status, code, message, body.params);
    }
    return body as T;
  }
  const json = (method: string, data: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });

  return {
    me: () => request<Me>("/me"),
    setNotification: (type: string, on: boolean) => request<{ notifyOff: string[] }>("/me/notifications", json("PATCH", { type, on })),
    acceptTerms: () => request("/me/accept-terms", { method: "POST" }),
    setLanguage: (language: Lang) => request("/me", json("PATCH", { language })),
    deleteAccount: () => request("/me", { method: "DELETE" }),
    createCheck: (lang: Lang, text: string, images: Blob[]) => {
      const form = new FormData();
      form.append("lang", lang);
      if (text.trim()) form.append("text", text.trim());
      images.forEach((img, i) => form.append("images", img, `screenshot-${i}.jpg`));
      return request<CheckResult>("/checks", { method: "POST", body: form });
    },
    getCheck: (id: string) => request<CheckResult>(`/checks/${encodeURIComponent(id)}`),

    // ---- seller cabinet ----
    createDraft: (photos: Blob[], audio: Blob | null, text: string) => {
      const form = new FormData();
      photos.forEach((p, i) => form.append("photos", p, `photo-${i}.jpg`));
      if (audio) form.append("audio", audio, `voice.${audio.type.includes("mp4") ? "m4a" : "webm"}`);
      if (text.trim()) form.append("text", text.trim());
      return request<ListingDto>("/listings/drafts", { method: "POST", body: form });
    },
    generate: (id: string, answers: Record<string, string>) =>
      request<ListingDto>(`/listings/${id}/generate`, json("POST", { answers })),
    updateListing: (id: string, patch: ListingPatch) => request<ListingDto>(`/listings/${id}`, json("PATCH", patch)),
    requestMeeting: (id: string, body: { spot: MeetingSpot | null; place: string | null; at: string; note: string | null }) =>
      request<MeetingDto>(`/listings/${id}/meetings`, json("POST", body)),
    meetings: () => request<MeetingDto[]>("/meetings"),
    meetingAction: (id: string, action: string, body: object = {}) => request<MeetingDto>(`/meetings/${id}/${action}`, json("POST", body)),
    offerToShops: (id: string) =>
      request<{ sent: number; deferredUntil: string | null }>(`/listings/${id}/offer-shops`, json("POST", {})),
    offerToLikers: (id: string, amount: number) =>
      request<{ sent: number; price: number; expiresAt: string; deferredUntil: string | null }>(`/listings/${id}/offer-likers`, json("POST", { amount })),
    addPhotos: (id: string, photos: Blob[]) => {
      const form = new FormData();
      photos.forEach((p, i) => form.append("photos", p, `photo-${i}.jpg`));
      return request<ListingDto>(`/listings/${id}/photos`, { method: "POST", body: form });
    },
    uploadVideo: (id: string, video: File) => {
      const form = new FormData();
      form.append("video", video, video.name || "video.mp4");
      return request<{ video: string }>(`/listings/${id}/video`, { method: "POST", body: form });
    },
    deleteVideo: (id: string) => request<{ video: null }>(`/listings/${id}/video`, { method: "DELETE" }),
    disputePhotos: (orderId: string, photos: Blob[]) => {
      const form = new FormData();
      photos.forEach((p, i) => form.append("photos", p, `photo-${i}.jpg`));
      return request<{ photos: string[] }>(`/orders/${orderId}/dispute/photos`, { method: "POST", body: form });
    },
    inspectionPhotos: (orderId: string, photos: Blob[]) => {
      const form = new FormData();
      photos.forEach((p, i) => form.append("photos", p, `photo-${i}.jpg`));
      return request<{ photos: string[] }>(`/operator/orders/${orderId}/inspection/photos`, { method: "POST", body: form });
    },
    deletePhoto: (id: string, photoId: number) => request<ListingDto>(`/listings/${id}/photos/${photoId}`, { method: "DELETE" }),
    publish: (id: string, channelIds: number[]) =>
      request<{ listing: ListingDto; postedChannels: number; failedChannels: number; moderation: ModerationDecision }>(
        `/listings/${id}/publish`,
        json("POST", { channelIds }),
      ),
    myListings: (status: ListingStatus) => request<ListingDto[]>(`/listings/mine?status=${status}`),
    listing: (id: string) => request<ListingDto>(`/listings/${encodeURIComponent(id)}`),
    markSold: (id: string, via: "platform" | "elsewhere") => request<ListingDto>(`/listings/${id}/sold`, json("POST", { via })),
    archive: (id: string) => request<ListingDto>(`/listings/${id}/archive`, { method: "POST" }),
    bump: (id: string) => request<ListingDto>(`/listings/${id}/bump`, { method: "POST" }),
    renew: (id: string) => request<ListingDto>(`/listings/${id}/renew`, { method: "POST" }),
    deleteDraft: (id: string) => request(`/listings/${id}`, { method: "DELETE" }),
    shop: () => request<ShopInfo>("/shops/mine"),
    saveShop: (name: string, marketLocation: string, bundle?: { bundle2Pct: number; bundle3Pct: number }) =>
      request<ShopInfo["shop"]>("/shops/mine", json("PUT", { name, marketLocation: marketLocation || null, ...bundle })),
    shopPhoto: (photo: Blob) => {
      const form = new FormData();
      form.append("photo", photo, "shop.jpg");
      return request<ShopInfo["shop"]>("/shops/mine/photo", { method: "POST", body: form });
    },
    unlinkChannel: (id: number) => request(`/channels/${id}`, { method: "DELETE" }),

    // ---- catalog & buyer tools ----
    catalog: (f: CatalogFilters, sort: CatalogSort, offset = 0) => request<CatalogPage>(`/catalog?${filtersToQuery(f, sort, offset)}`),
    catalogItem: (id: string) => request<CatalogItem>(`/catalog/${encodeURIComponent(id)}`),
    similar: (listingId: string) => request<CatalogItem[]>(`/catalog/${listingId}/similar`),
    catalogBatch: (ids: string[]) => (ids.length ? request<CatalogItem[]>(`/catalog/batch?ids=${ids.join(",")}`) : Promise.resolve([])),
    sellerPage: (sellerId: string) =>
      request<{ seller: ListingSeller; trust: TrustLevel; items: CatalogItem[]; following: boolean }>(`/sellers/${sellerId}/page`),
    follow: (sellerId: string, on: boolean) =>
      request<{ following: boolean; followers: number }>(`/sellers/${sellerId}/follow`, { method: on ? "POST" : "DELETE" }),
    following: () => request<ListingSeller[]>("/me/following"),
    insights: (listingId: string) => request<ListingInsights>(`/listings/${listingId}/insights`),
    shareLink: (listingId: string) => request<{ url: string | null }>(`/listings/${listingId}/share`),
    myOffer: (listingId: string) => request<{ offer: OfferDto | null }>(`/listings/${listingId}/offers/mine`),
    makeOffer: (listingId: string, amount: number) => request<OfferDto>(`/listings/${listingId}/offers`, json("POST", { amount })),
    tradeOffer: (listingId: string, input: { title: string; condition: Condition; description?: string; topUp: number }) =>
      request<OfferDto>(`/listings/${listingId}/trade-offers`, json("POST", input)),
    valuation: (q: string, condition: Condition) => request<Valuation>(`/valuation?${new URLSearchParams({ q, condition }).toString()}`),
    valuationModels: (q: string) => request<{ models: string[] }>(`/valuation/models?q=${encodeURIComponent(q)}`),
    setFavorite: (id: string, on: boolean) => request(`/favorites/${id}`, { method: on ? "POST" : "DELETE" }),
    favorites: () => request<CatalogItem[]>("/favorites"),
    searches: () => request<SavedSearch[]>("/searches"),
    saveSearch: (f: CatalogFilters) => request<SavedSearch>("/searches", json("POST", f)),
    deleteSearch: (id: number) => request(`/searches/${id}`, { method: "DELETE" }),
    contact: (id: string, text: string) => request<{ ok: true }>(`/listings/${id}/contact`, json("POST", { text })),
    complain: (id: string, reason: ComplaintReason, text: string) =>
      request<{ ok: true; duplicate: boolean; hidden: boolean }>(`/listings/${id}/complaints`, json("POST", { reason, text: text || undefined })),
    sellerReviews: (sellerId: string) => request<{ rating: SellerRating; reviews: ReviewDto[] }>(`/sellers/${sellerId}/reviews`),

    // ---- delivery ----
    quote: (listingId: string, district: District, mode: DeliveryMode, extra: string[] = [], lift: LiftInfo | null = null) =>
      request<DeliveryQuote & { modes: DeliveryMode[]; bundle: BundleQuote | null; offerId: string | null }>(
        `/orders/quote?${new URLSearchParams({
          listingId,
          district,
          mode,
          ...(extra.length ? { extra: extra.join(",") } : {}),
          ...(lift ? { floor: String(lift.floor), elevator: lift.elevator ? "1" : "0" } : {}),
        }).toString()}`,
      ),
    bundleCandidates: (listingId: string) => request<ListingDto[]>(`/orders/bundle-candidates?listingId=${listingId}`),
    createOrder: (input: CreateOrderInput) => request<OrderDto>("/orders", json("POST", input)),
    myOrders: (role: "buyer" | "seller") => request<OrderDto[]>(`/orders/mine?role=${role}`),
    order: (id: string) => request<OrderDto>(`/orders/${encodeURIComponent(id)}`),
    orderAction: (id: string, action: "confirm" | "decline" | "cancel") => request<OrderDto>(`/orders/${id}/${action}`, { method: "POST" }),
    openDispute: (id: string, reason: DisputeReason, text: string) => request<OrderDto>(`/orders/${id}/dispute`, json("POST", { reason, text })),
    respondDispute: (id: string, text: string) => request<OrderDto>(`/orders/${id}/dispute/response`, json("POST", { text })),
    adminDisputes: (all = false) => request<AdminDispute[]>(`/admin/disputes${all ? "?all=1" : ""}`),
    resolveDispute: (id: string, resolution: DisputeResolution, amount?: number, note?: string) =>
      request<DisputeDto>(`/admin/disputes/${id}/resolve`, json("POST", { resolution, amount, note: note || undefined })),
    review: (id: string, rating: number, text: string) =>
      request<OrderDto>(`/orders/${id}/review`, json("POST", { rating, text: text.trim() || undefined })),

    // ---- staff: admin & operators ----
    adminMetrics: (days: number) => request<AdminMetrics>(`/admin/metrics?days=${days}`),
    /** Absolute signed link (5 minutes) that Telegram's downloader can fetch without our auth header. */
    ordersCsvLink: async (days: number) => {
      const { url } = await request<{ url: string }>("/admin/reports/orders.csv/link", json("POST", { days }));
      return new URL(`${BASE}${url}`, window.location.href).href;
    },
    audit: () =>
      request<Array<{ id: number; actorTelegramId: number | null; action: string; target: string | null; details: Record<string, unknown>; createdAt: string }>>(
        "/admin/audit",
      ),
    sendDigest: () => request<{ sent: number }>("/admin/digest", { method: "POST" }),
    moderationQueue: () => request<QueueItem[]>("/admin/moderation"),
    moderate: (id: string, decision: "approve" | "reject") =>
      request<{ status: string }>(`/admin/listings/${id}/moderate`, json("POST", { decision })),
    complaints: () => request<ComplaintRow[]>("/admin/complaints"),
    findUser: (telegramId: string) => request<AdminUser>(`/admin/users?telegramId=${encodeURIComponent(telegramId)}`),
    bannedUsers: () => request<Array<Pick<AdminUser, "id" | "telegramId" | "bannedAt" | "banReason" | "role">>>("/admin/users/banned"),
    blocks: () => request<Array<{ userId: string; title: string | null; role: "buyer" | "seller" | null; createdAt: string }>>("/me/blocks"),
    unblock: (userId: string) => request(`/me/blocks/${userId}`, { method: "DELETE" }),
    chatReports: () => request<ChatReport[]>("/admin/chat-reports"),
    resolveChatReport: (id: number, resolution: "dismissed" | "warned" | "banned") =>
      request(`/admin/chat-reports/${id}/resolve`, json("POST", { resolution })),
    ban: (id: string, reason: string) => request(`/admin/users/${id}/ban`, json("POST", { reason })),
    unban: (id: string) => request(`/admin/users/${id}/unban`, { method: "POST" }),
    prices: () => request<PriceRow[]>("/admin/price-reference"),
    importPrices: (csv: string) =>
      request<{ imported: number; errors: string[] }>("/admin/price-reference/import", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      }),
    deletePrice: (id: number) => request(`/admin/price-reference/${id}`, { method: "DELETE" }),
    tariffs: () => request<CourierTariff[]>("/admin/tariffs"),
    saveTariffs: (rows: Array<Omit<CourierTariff, "id">>) => request<CourierTariff[]>("/admin/tariffs", json("PUT", rows)),
    settings: () => request<AdminSettings>("/admin/settings"),
    saveSettings: (s: Partial<AdminSettings>) => request<AdminSettings>("/admin/settings", json("PUT", s)),
    operatorOrders: (status?: OrderStatus) => request<OperatorOrder[]>(`/operator/orders${status ? `?status=${status}` : ""}`),
    inspect: (id: string, checks: Partial<Record<InspectionCheck, boolean>>, note?: string) =>
      request<OrderDto>(`/operator/orders/${id}/inspection`, json("POST", { checks, note })),
    operatorStatus: (id: string, status: OrderStatus, extra: { courierName?: string; courierPhone?: string; note?: string } = {}) =>
      request<{ order: OrderDto }>(`/operator/orders/${id}/status`, json("POST", { status, ...extra })),

    assistant: (messages: AssistantMessage[], lang: Lang) => request<AssistantResponse>("/assistant", json("POST", { messages, lang })),
    compare: (ids: string[], lang: Lang, needs?: string) =>
      request<CompareResponse>("/assistant/compare", json("POST", { ids, lang, needs })),
  };
}

export type Api = ReturnType<typeof createApi>;

/** Downscale screenshots to ≤1600px JPEG: faster upload and fewer AI tokens. */
export async function compressImage(file: File, maxSide = 1600): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/jpeg", 0.85));
}
