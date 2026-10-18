import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull().unique(),
  phone: text("phone"),
  language: text("language").notNull().default("uz"),
  role: text("role").notNull().default("buyer"),
  acceptedTermsAt: timestamp("accepted_terms_at", { withTimezone: true }),
  createdAt: createdAt(),
  bannedAt: timestamp("banned_at", { withTimezone: true }),
  banReason: text("ban_reason"),
  /** Optional notification types the user switched off (NOTIFY_TYPES, stage 20). */
  notifyOff: text("notify_off").array().notNull().default(sql`'{}'::text[]`),
});

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  parentId: integer("parent_id"),
  slug: text("slug").notNull().unique(),
  nameRu: text("name_ru").notNull(),
  nameUz: text("name_uz").notNull(),
  attributesSchema: jsonb("attributes_schema").notNull().default({}),
});

export const priceReference = pgTable(
  "price_reference",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id").references(() => categories.id),
    modelKey: text("model_key").notNull().unique(),
    priceMin: bigint("price_min", { mode: "number" }).notNull(),
    priceMedian: bigint("price_median", { mode: "number" }).notNull(),
    priceMax: bigint("price_max", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").notNull().default("manual"),
  },
  (t) => [index("price_reference_model_key_trgm").using("gin", sql`${t.modelKey} gin_trgm_ops`)],
);

/** One module-B check. Only anonymised data is stored (no screenshots, names or phones). */
export const checks = pgTable(
  "checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    lang: text("lang").notNull(),
    inputType: text("input_type").notNull(),
    extracted: jsonb("extracted").notNull(),
    priceVerdict: text("price_verdict").notNull(),
    priceDiffPct: integer("price_diff_pct"),
    priceUzs: bigint("price_uzs", { mode: "number" }),
    priceSource: text("price_source").notNull(),
    riskScore: integer("risk_score").notNull(),
    riskLevel: text("risk_level").notNull(),
    flags: jsonb("flags").notNull(),
    result: jsonb("result").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6, mode: "number" }).notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("checks_user_created_idx").on(t.userId, t.createdAt)],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    promptId: text("prompt_id"),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6, mode: "number" }).notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    requestId: text("request_id"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_created_idx").on(t.createdAt)],
);

export const events = pgTable("events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  props: jsonb("props").notNull().default({}),
  createdAt: createdAt(),
});

/** Runtime-editable configuration (limits, risk rules, currency rate). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const shops = pgTable("shops", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  marketLocation: text("market_location"),
  photoKey: text("photo_key"),
  verified: boolean("verified").notNull().default(false),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  /** Discount for several items in one delivery (stage 17): % for 2 items and for 3 or more; 0 — none. */
  bundle2Pct: integer("bundle2_pct").notNull().default(0),
  bundle3Pct: integer("bundle3_pct").notNull().default(0),
  createdAt: createdAt(),
});

/** Telegram channels where the bot is an admin and may post the owner's listings. */
export const channels = pgTable("channels", {
  id: serial("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  shopId: uuid("shop_id").references(() => shops.id, { onDelete: "set null" }),
  telegramChannelId: bigint("telegram_channel_id", { mode: "number" }).notNull().unique(),
  title: text("title").notNull(),
  createdAt: createdAt(),
});

export const listings = pgTable(
  "listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shopId: uuid("shop_id").references(() => shops.id, { onDelete: "set null" }),
    categoryId: integer("category_id").references(() => categories.id),
    category: text("category").notNull().default("other"),
    titleRu: text("title_ru").notNull().default(""),
    titleUz: text("title_uz").notNull().default(""),
    descriptionRu: text("description_ru").notNull().default(""),
    descriptionUz: text("description_uz").notNull().default(""),
    attributes: jsonb("attributes").notNull().default({}),
    condition: text("condition"),
    price: bigint("price", { mode: "number" }),
    /** Price before the last reduction (shown crossed out for a while; favorites get an alert). */
    previousPrice: bigint("previous_price", { mode: "number" }),
    priceDroppedAt: timestamp("price_dropped_at", { withTimezone: true }),
    /** Phones: 15-digit IMEI (Luhn-checked). Only the owner and operators see it; buyers see the last 4 digits. */
    imei: text("imei"),
    /**
     * Last answer of the lost/stolen registry for `imei` (IMEI_REGISTRY); stale once the IMEI changes.
     * `cleared`: a moderator approved the listing despite "listed", so edits don't send it back for the same reason.
     */
    imeiRegistry: jsonb("imei_registry").$type<{ imei: string; status: "clean" | "listed"; provider: string; at: string; cleared?: boolean }>(),
    /** Phones/tablets: structured condition (battery %, biometrics, repairs, kit), see ConditionChecklist. */
    checklist: jsonb("checklist").notNull().default({}),
    /** "Рассмотрю обмен": buyers may propose their item plus a top-up. */
    acceptsTrade: boolean("accepts_trade").notNull().default(false),
    /** Автоснижение: −5 % every 3 days down to this floor; null = off. `autoDropAt` is the next step. */
    autoDropFloor: bigint("auto_drop_floor", { mode: "number" }),
    autoDropAt: timestamp("auto_drop_at", { withTimezone: true }),
    /** The last «Предложить избранным»: price and time (limits how often and how high the next one is). */
    likersOfferPrice: bigint("likers_offer_price", { mode: "number" }),
    likersOfferAt: timestamp("likers_offer_at", { withTimezone: true }),
    /** «Предложить магазинам»: last time the listing went to verified shops (once a week). */
    shopsOfferAt: timestamp("shops_offer_at", { withTimezone: true }),
    /**
     * Condition grade A–D (catalog filter «Класс A–B»). Mirrors computeGrade() in @ishonch/shared/passport —
     * the condition sets the best grade, checklist facts only lower it; a test keeps the two identical.
     */
    grade: text("grade").generatedAlwaysAs(
      sql`case
        when condition is null or condition = 'unknown' then null
        when condition = 'broken' then 'D'
        when condition = 'fair'
          or (checklist->>'batteryPct')::int < 80
          or checklist->>'biometrics' = 'broken'
          or checklist->>'deadPixels' = 'many' then 'C'
        when condition = 'good'
          or (checklist->>'batteryPct')::int < 85
          or checklist->>'deadPixels' = 'few'
          or checklist->>'mining' = 'yes'
          or checklist->'repairs' @> '["screen"]' or checklist->'repairs' @> '["battery"]'
          or checklist->'repairs' @> '["back"]' or checklist->'repairs' @> '["other"]' then 'B'
        else 'A'
      end`,
    ),
    /** «Проверено Ishonch»: the courier's inspection passed (badge while recent), see Inspection. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verification: jsonb("verification"),
    currency: text("currency").notNull().default("UZS"),
    district: text("district"),
    allowedDeliveryModes: text("allowed_delivery_modes").array().notNull().default(sql`ARRAY['delivery_only','cod_seller']::text[]`),
    feePayer: text("fee_payer").notNull().default("buyer"),
    status: text("status").notNull().default("draft"),
    moderationReason: text("moderation_reason"),
    /** Last moderation result (AI / rules / admin / complaints), see ModerationRecord. */
    moderation: jsonb("moderation"),
    riskScore: integer("risk_score"),
    /** AI analysis (questions, photo hints, market estimate) and seller answers. */
    aiDraft: jsonb("ai_draft").notNull().default({}),
    priceSuggestion: jsonb("price_suggestion"),
    sourceText: text("source_text"),
    views: integer("views").notNull().default(0),
    favoritesCount: integer("favorites_count").notNull().default(0),
    requestsCount: integer("requests_count").notNull().default(0),
    channelPosts: jsonb("channel_posts").notNull().default([]),
    soldVia: text("sold_via"),
    soldAt: timestamp("sold_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    bumpedAt: timestamp("bumped_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    expiryRemindedAt: timestamp("expiry_reminded_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("listings_seller_status_idx").on(t.sellerUserId, t.status),
    index("listings_status_bumped_idx").on(t.status, t.bumpedAt),
    index("listings_status_expires_idx").on(t.status, t.expiresAt),
    index("listings_imei_idx").on(t.imei).where(sql`${t.imei} is not null`),
    // Duplicate-description check at publication (`%` prefilter, then similarity()).
    index("listings_description_trgm_idx").using("gin", sql`(coalesce(nullif(${t.descriptionRu}, ''), ${t.descriptionUz})) gin_trgm_ops`),
  ],
);

export const listingPhotos = pgTable(
  "listing_photos",
  {
    id: serial("id").primaryKey(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    phash: text("phash"),
    width: integer("width"),
    height: integer("height"),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("listing_photos_listing_idx").on(t.listingId), index("listing_photos_phash_idx").on(t.phash)],
);

export const favorites = pgTable(
  "favorites",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.listingId] })],
);

export const savedSearches = pgTable(
  "saved_searches",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    filters: jsonb("filters").notNull(),
    title: text("title").notNull(),
    /** «Куплю» (stage 25): sellers may see this search (without the buyer) and answer with their listing. */
    public: boolean("public").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("saved_searches_user_idx").on(t.userId)],
);

/** Sent notifications: dedupe per (search, listing) and enforce ≤3 per user per day. */
export const searchNotifications = pgTable(
  "search_notifications",
  {
    id: serial("id").primaryKey(),
    savedSearchId: integer("saved_search_id")
      .notNull()
      .references(() => savedSearches.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("search_notifications_user_created_idx").on(t.userId, t.createdAt)],
);

/** Masked buyer ↔ seller chat relayed by the bot (names and phones are never shown). */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    buyerUserId: uuid("buyer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last AI reply suggestions for the seller: { items: string[], at } (sent by index from bot buttons). */
    suggestions: jsonb("suggestions"),
  },
  (t) => [
    index("conversations_buyer_idx").on(t.buyerUserId, t.listingId),
    // Seller's typical reply time (listing card).
    index("conversations_seller_created_idx").on(t.sellerUserId, t.createdAt),
  ],
);

export const conversationMessages = pgTable("conversation_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  senderUserId: uuid("sender_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  createdAt: createdAt(),
});

/**
 * Buyer's price offer ("торг"): pending → accepted / declined / expired. An accepted offer is valid for
 * OFFER_ACCEPTED_HOURS and replaces the listing price in that buyer's delivery quote.
 */
export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    buyerUserId: uuid("buyer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** price | trade (the buyer's item + a top-up, see TradeItem). */
    kind: text("kind").notNull().default("price"),
    /** Price offer: the price. Trade: the top-up, > 0 from the buyer, < 0 from the seller. */
    amount: bigint("amount", { mode: "number" }).notNull(),
    trade: jsonb("trade"),
    /** Listing price when the offer was made. */
    listPrice: bigint("list_price", { mode: "number" }).notNull(),
    status: text("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("offers_listing_buyer_idx").on(t.listingId, t.buyerUserId, t.createdAt),
    index("offers_seller_idx").on(t.sellerUserId, t.createdAt),
    // One live offer per buyer and listing: a new one waits until the previous is answered or expires.
    uniqueIndex("offers_one_pending_idx").on(t.listingId, t.buyerUserId).where(sql`${t.status} = 'pending'`),
  ],
);

/** Courier prices by district; the most specific active row wins (see pickTariff). */
export const courierTariffs = pgTable("courier_tariffs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** courier | cargo (big appliances: cargo taxi with movers). */
  vehicle: text("vehicle").notNull().default("courier"),
  fromDistrict: text("from_district"),
  toDistrict: text("to_district"),
  price: bigint("price", { mode: "number" }).notNull(),
  codFeePct: numeric("cod_fee_pct", { precision: 5, scale: 2, mode: "number" }).notNull().default(0),
  /** Cargo: movers' fee per floor above the first when there is no lift. */
  liftPerFloor: bigint("lift_per_floor", { mode: "number" }).notNull().default(0),
  active: boolean("active").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Delivery request: buyer → seller confirms → operator and courier → delivered / returned. */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    buyerUserId: uuid("buyer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("new"),
    district: text("district").notNull(),
    address: text("address").notNull(),
    comment: text("comment"),
    /** Snapshot at order time: item price, fees and who pays them (DeliveryQuote). */
    quote: jsonb("quote").notNull(),
    feePayer: text("fee_payer").notNull(),
    provider: text("provider").notNull().default("manual"),
    externalId: text("external_id"),
    courierName: text("courier_name"),
    courierPhone: text("courier_phone"),
    cancelReason: text("cancel_reason"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Several items of one seller in one delivery: every order of the bundle carries the first order's id. */
    bundleId: uuid("bundle_id"),
    /** Courier's inspection at pickup (checklist), see Inspection. */
    inspection: jsonb("inspection"),
    reviewRemindedAt: timestamp("review_reminded_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orders_buyer_idx").on(t.buyerUserId, t.createdAt),
    index("orders_seller_idx").on(t.sellerUserId, t.createdAt),
    index("orders_listing_status_idx").on(t.listingId, t.status),
    index("orders_status_idx").on(t.status, t.updatedAt),
    index("orders_bundle_idx").on(t.bundleId).where(sql`${t.bundleId} is not null`),
    // Race-safe invariants the code relies on (unique violation → "already_ordered" / "not_available"):
    // one open order per buyer and listing, one reservation (confirmed order) per listing.
    uniqueIndex("orders_one_open_per_buyer_uq")
      .on(t.listingId, t.buyerUserId)
      .where(sql`${t.status} in ('new', 'confirmed', 'courier_assigned', 'picked_up')`),
    uniqueIndex("orders_one_reservation_per_listing_uq")
      .on(t.listingId)
      .where(sql`${t.status} in ('confirmed', 'courier_assigned', 'picked_up')`),
  ],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actor: text("actor").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId)],
);

/** Ishonch guarantee: the buyer's claim after delivery, decided by an admin. One per order. */
export const disputes = pgTable(
  "disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    buyerUserId: uuid("buyer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    text: text("text").notNull(),
    sellerResponse: text("seller_response"),
    /** open | resolved */
    status: text("status").notNull().default("open"),
    /** refund | partial | rejected */
    resolution: text("resolution"),
    amount: bigint("amount", { mode: "number" }),
    note: text("note"),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("disputes_status_idx").on(t.status, t.createdAt), index("disputes_seller_idx").on(t.sellerUserId, t.resolution)],
);

/**
 * Evidence files (docs/plan.md, stage 15): the buyer's photos for a dispute, the courier's photos at the
 * pickup inspection and the seller's short video check of the item. Served by signed URL (/media/:id).
 */
export const evidence = pgTable(
  "evidence",
  {
    id: serial("id").primaryKey(),
    /** dispute_photo | inspection_photo | listing_video */
    kind: text("kind").notNull(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("evidence_listing_idx").on(t.listingId, t.kind), index("evidence_order_idx").on(t.orderId, t.kind)],
);

/** One review per delivered order, written by the buyer about the seller. */
export const reviews = pgTable(
  "reviews",
  {
    id: serial("id").primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    buyerUserId: uuid("buyer_user_id").references(() => users.id, { onDelete: "set null" }),
    rating: integer("rating").notNull(),
    text: text("text"),
    createdAt: createdAt(),
  },
  (t) => [index("reviews_seller_idx").on(t.sellerUserId, t.createdAt)],
);

export const complaints = pgTable(
  "complaints",
  {
    id: serial("id").primaryKey(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    text: text("text"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("complaints_listing_user_uq").on(t.listingId, t.userId),
    index("complaints_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * Background jobs (saved-search alerts, channel posts): a table queue polled with FOR UPDATE SKIP LOCKED,
 * so any number of API instances share the work and a crashed worker's job is retried after `lockedUntil`.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_due_idx").on(t.runAt).where(sql`${t.doneAt} is null`)],
);

/** Running AI spend per calendar month (UTC) and model tier; incremented atomically after each call. */
export const aiBudget = pgTable(
  "ai_budget",
  {
    month: text("month").notNull(),
    tier: text("tier").notNull(),
    spentUsd: numeric("spent_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    calls: integer("calls").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.month, t.tier] })],
);

/** Who did what in the admin panel and staff chats (moderation, bans, settings, tariffs, prices). */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorTelegramId: bigint("actor_telegram_id", { mode: "number" }),
    action: text("action").notNull(),
    target: text("target"),
    details: jsonb("details").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("admin_audit_created_idx").on(t.createdAt)],
);

/** Bot state "the next text of this user is a reply in conversation X" (shared by bot instances, survives restarts). */
export const botPendingReplies = pgTable("bot_pending_replies", {
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).primaryKey(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type User = typeof users.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Listing = typeof listings.$inferSelect;
export type Shop = typeof shops.$inferSelect;

/**
 * A buyer following a seller or shop (stage 17): new listings come as one message a day at most
 * (last_notified_at is claimed atomically) and never at night.
 */
export const follows = pgTable(
  "follows",
  {
    followerUserId: uuid("follower_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.followerUserId, t.sellerUserId] }), index("follows_seller_idx").on(t.sellerUserId)],
);

/**
 * A meeting in person arranged on Ishonch (stage 18): the buyer proposes a place and an hour, the seller
 * answers in the bot; payment happens hand to hand and never passes through Ishonch.
 */
export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    buyerUserId: uuid("buyer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** A spot from MEETING_SPOTS, or null with `place` written by the buyer. */
    spot: text("spot"),
    place: text("place"),
    at: timestamp("at", { withTimezone: true }).notNull(),
    note: text("note"),
    status: text("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("meetings_listing_idx").on(t.listingId),
    index("meetings_buyer_idx").on(t.buyerUserId),
    index("meetings_seller_idx").on(t.sellerUserId),
    // One open request per buyer and item, also under parallel taps.
    uniqueIndex("meetings_open_uq").on(t.listingId, t.buyerUserId).where(sql`status in ('pending', 'accepted')`),
  ],
);

/**
 * A user blocked another one (stage 19): no messages and no meeting requests between them, either way.
 * `listing_id` only reminds the blocker where they met (identities stay masked).
 */
export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerUserId: uuid("blocker_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedUserId: uuid("blocked_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    listingId: uuid("listing_id").references(() => listings.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerUserId, t.blockedUserId] }), index("user_blocks_blocked_idx").on(t.blockedUserId)],
);

/** A complaint about a conversation (stage 19): moderators see the last messages and decide. One per reporter. */
export const chatReports = pgTable(
  "chat_reports",
  {
    id: serial("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    reporterUserId: uuid("reporter_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reportedUserId: uuid("reported_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("chat_reports_conv_reporter_uq").on(t.conversationId, t.reporterUserId)],
);
