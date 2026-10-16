import { z } from "zod";
import { CHECK_CATEGORIES, CURRENCIES } from "./types.js";
import { CONDITIONS, DELIVERY_MODES, TASHKENT_DISTRICTS } from "./listing.js";
import { COMPLAINT_REASONS, MODERATION_REASONS } from "./delivery.js";
import { BIOMETRICS_STATES, INSPECTION_CHECKS, KIT_ITEMS, MAX_BUNDLE_EXTRA, MINING_STATES, PIXEL_STATES, REPAIR_KINDS } from "./market.js";

/**
 * Every zod schema of the project (AI outputs, API inputs, settings). Kept apart from constants and
 * helpers so the Mini App, which imports `@ishonch/shared/client`, ships without zod.
 */

// ---------- from types.ts ----------
/**
 * Data extracted from a third-party listing. Must stay anonymised:
 * no seller names, phone numbers, usernames or links are allowed here.
 */
export const ExtractedListingSchema = z.object({
  is_listing: z.boolean().describe("false if the input is not a product listing at all"),
  category: z.enum(CHECK_CATEGORIES),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  model_key: z
    .string()
    .nullable()
    .describe("normalised lowercase key like 'apple iphone 13 128gb'"),
  specs: z.array(z.string()).describe("key characteristics, e.g. '128 GB', 'battery 87%'"),
  condition: z.enum(["new", "like_new", "good", "fair", "broken", "unknown"]),
  price_amount: z.number().nullable().describe("numeric price as written, e.g. 3500000 or 300"),
  price_currency: z.enum(CURRENCIES).nullable(),
  city: z.string().nullable(),
  seller_signals: z.object({
    prepayment: z.boolean().describe("asks for prepayment, card transfer, deposit/zadatok"),
    other_city: z.boolean().describe("seller is in another city or region"),
    shipping_only: z.boolean().describe("offers to send by post/courier only, no meeting"),
    urgency: z.boolean().describe("pressure: 'today only', 'many buyers', 'urgent'"),
    stock_photos: z.boolean().describe("photos look like stock/catalog images"),
    no_meeting: z.boolean().describe("refuses inspection or meeting"),
  }),
  suspicious_phrases: z.array(z.string()).describe("short anonymised quotes that look suspicious"),
  ai_market_estimate_uzs: z
    .object({ min: z.number(), max: z.number() })
    .nullable()
    .describe("rough Tashkent second-hand price range in UZS if you know it, else null"),
});

export type ExtractedListing = z.infer<typeof ExtractedListingSchema>;

export const CheckReportSchema = z.object({
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  questions: z.array(z.string()).describe("exactly 5 questions to ask the seller"),
  extra_red_flags: z.array(z.string()).describe("additional concrete red flags not already listed"),
  risk_adjustment: z
    .number()
    .describe("AI correction to the rule-based risk score, from -15 to 15"),
});

export type CheckReport = z.infer<typeof CheckReportSchema>;

// ---------- from listing.ts ----------
/** Step 1: what the AI can see in the photos / hear in the voice note. */
export const ListingAnalysisSchema = z.object({
  category: z.enum(CHECK_CATEGORIES),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  model_key: z.string().nullable().describe("lowercase 'brand model storage', e.g. 'apple iphone 13 128gb'"),
  specs: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .describe("only characteristics that are visible or stated; never guessed"),
  condition: z.enum([...CONDITIONS, "unknown"]),
  visible_defects: z.array(z.string()).describe("scratches, cracks, dents actually visible in photos"),
  questions: z
    .array(
      z.object({
        key: z.string().describe("snake_case id, e.g. storage, battery_health, kit, warranty"),
        question_ru: z.string(),
        question_uz: z.string(),
        options: z.array(z.string()).describe("2-5 short answer options, may be empty for free text"),
      }),
    )
    .describe("1-3 questions about important missing facts; empty if nothing important is missing"),
  photo_hints: z
    .array(z.object({ ru: z.string(), uz: z.string() }))
    .describe("advice to improve photos, e.g. 'add a photo of the screen turned on'"),
  ai_market_estimate_uzs: z.object({ min: z.number(), max: z.number() }).nullable(),
});

export type ListingAnalysis = z.infer<typeof ListingAnalysisSchema>;

/** Step 2: the selling text in both languages. */
export const ListingTextSchema = z.object({
  title_ru: z.string(),
  title_uz: z.string(),
  description_ru: z.string(),
  description_uz: z.string(),
});

export type ListingText = z.infer<typeof ListingTextSchema>;

// ---------- from catalog.ts ----------
/** Filters shared by the catalog, the AI assistant and saved searches. */
export const CatalogFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.enum(CHECK_CATEGORIES).optional(),
  priceMin: z.coerce.number().int().nonnegative().optional(),
  priceMax: z.coerce.number().int().positive().optional(),
  conditions: z.array(z.enum(CONDITIONS)).optional(),
  district: z.enum(TASHKENT_DISTRICTS).optional(),
  verifiedOnly: z.coerce.boolean().optional(),
});

export type CatalogFilters = z.infer<typeof CatalogFiltersSchema>;

export const AssistantMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});

export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

/** Step 1 (economical model): understand the request, ask or search. */
export const AssistantQuerySchema = z.object({
  action: z.enum(["ask", "search", "off_topic"]),
  reply: z.string().describe("short text for the user in their language: the question(s), or what you are searching for"),
  questions: z.array(z.string()).describe("0-2 clarifying questions when action=ask"),
  filters: z.object({
    category: z.enum(CHECK_CATEGORIES).nullable(),
    keywords: z.string().nullable().describe("search words for brand/model/type, e.g. 'macbook' or 'наушники'"),
    price_max_uzs: z.number().nullable(),
    price_min_uzs: z.number().nullable(),
    min_condition: z.enum(CONDITIONS).nullable(),
    district: z.enum(TASHKENT_DISTRICTS).nullable(),
    verified_only: z.boolean(),
  }),
  needs: z.string().describe("one sentence summary of what the buyer needs and why (used to rank options)"),
});

export type AssistantQuery = z.infer<typeof AssistantQuerySchema>;

/** Step 2 (strong model): choose among real candidates only. */
export const AssistantRecommendSchema = z.object({
  summary: z.string(),
  options: z.array(
    z.object({
      listing_id: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
      fit: z.string().describe("one sentence: why this option fits (or partly fits) the buyer's needs"),
    }),
  ),
});

export type AssistantRecommend = z.infer<typeof AssistantRecommendSchema>;

export const AssistantCompareSchema = z.object({
  summary: z.string(),
  verdicts: z.array(z.object({ listing_id: z.string(), best_for: z.string() })),
});

export type AssistantCompare = z.infer<typeof AssistantCompareSchema>;

// ---------- from delivery.ts ----------
export const CreateOrderSchema = z.object({
  listingId: z.string().uuid(),
  mode: z.enum(DELIVERY_MODES),
  district: z.enum(TASHKENT_DISTRICTS),
  address: z.string().trim().min(5).max(300),
  comment: z.string().trim().max(300).optional(),
  /** More items of the same seller in this delivery (one delivery fee). */
  extraListingIds: z.array(z.string().uuid()).max(MAX_BUNDLE_EXTRA).optional(),
});

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

const uniq = <T extends string>(a: T[]) => [...new Set(a)];

export const ConditionChecklistSchema = z
  .object({
    batteryPct: z.number().int().min(1).max(100).optional(),
    biometrics: z.enum(BIOMETRICS_STATES).optional(),
    repairs: z.array(z.enum(REPAIR_KINDS)).max(REPAIR_KINDS.length).transform(uniq).optional(),
    kit: z.array(z.enum(KIT_ITEMS)).max(KIT_ITEMS.length).transform(uniq).optional(),
    mining: z.enum(MINING_STATES).optional(),
    deadPixels: z.enum(PIXEL_STATES).optional(),
    ageYears: z.number().int().min(0).max(40).optional(),
  })
  .strict()
  // "No repairs" together with a repair is a contradiction: the repair wins.
  .transform((c) => (c.repairs && c.repairs.length > 1 ? { ...c, repairs: c.repairs.filter((r) => r !== "none") } : c));

export const InspectionInputSchema = z.object({
  checks: z.partialRecord(z.enum(INSPECTION_CHECKS), z.boolean()),
  note: z.string().trim().max(300).optional(),
});

export const ReplySuggestionsSchema = z.object({
  replies: z.array(z.string().describe("one ready-to-send message, ≤ 200 characters")).min(1).max(3),
});

export const OfferInputSchema = z.object({
  amount: z.number().int().positive().max(10_000_000_000),
});

export const ReviewInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  text: z.string().trim().max(500).optional(),
});

export const ComplaintInputSchema = z.object({
  reason: z.enum(COMPLAINT_REASONS),
  text: z.string().trim().max(500).optional(),
});

export const ListingModerationSchema = z.object({
  decision: z.enum(["approved", "needs_review", "rejected"]),
  reasons: z.array(
    z.object({
      code: z.enum(MODERATION_REASONS),
      note: z.string().describe("short explanation in Russian for the moderator"),
    }),
  ),
  seller_message_ru: z.string().describe("one polite sentence for the seller if not approved, else empty"),
  seller_message_uz: z.string().describe("the same in Uzbek (Latin), else empty"),
});

export type ListingModeration = z.infer<typeof ListingModerationSchema>;

// ---------- from admin.ts ----------
/** Runtime settings an admin may change from the admin panel (stored in `settings`, cached for 60 s). */
export const AdminSettingsSchema = z
  .object({
    checks_per_day: z.number().int().min(1).max(100),
    assistant_per_day: z.number().int().min(1).max(200),
    usd_rate: z.number().int().min(1000).max(100_000),
    ai_monthly_limit_usd: z.number().min(1).max(10_000),
    ai_strong_monthly_limit_usd: z.number().min(0).max(10_000),
    complaints_to_hide: z.number().int().min(1).max(20),
    listing_ai_per_day: z.number().int().min(1).max(500),
  })
  .partial();

export type AdminSettings = Required<z.infer<typeof AdminSettingsSchema>>;
export const ADMIN_SETTING_KEYS = Object.keys(AdminSettingsSchema.shape) as Array<keyof AdminSettings>;

// ---------- from risk/score.ts ----------
export const RiskRulesSchema = z.object({
  version: z.number(),
  priceBelowMarketPct: z.number(),
  newAccountDays: z.number(),
  aiAdjustmentMax: z.number(),
  levels: z.object({ medium: z.number(), high: z.number() }),
  weights: z.record(z.string(), z.number()),
});

export type RiskRules = z.infer<typeof RiskRulesSchema>;
