import type { ListingModeration } from "./schemas.js";
import { DELIVERY_MODES, TASHKENT_DISTRICTS, type DeliveryMode, type District, type FeePayer } from "./listing.js";
import type { Inspection } from "./market.js";

// ---------- delivery orders ----------

export const ORDER_STATUSES = [
  "new", // buyer requested, waiting for the seller
  "confirmed", // seller confirmed, the item is reserved, operator arranges a courier
  "courier_assigned",
  "picked_up", // courier has the item
  "delivered", // buyer inspected and accepted the item
  "returned", // buyer refused at inspection, item goes back to the seller
  "cancelled",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const OPEN_ORDER_STATUSES: OrderStatus[] = ["new", "confirmed", "courier_assigned", "picked_up"];
/** After confirmation the listing is reserved for this buyer. */
export const RESERVING_ORDER_STATUSES: OrderStatus[] = ["confirmed", "courier_assigned", "picked_up"];

export type OrderActor = "buyer" | "seller" | "operator";

/** Allowed status changes and who may make them. Everything else is rejected by the API. */
export const ORDER_TRANSITIONS: Record<OrderStatus, Partial<Record<OrderStatus, OrderActor[]>>> = {
  new: { confirmed: ["seller"], cancelled: ["buyer", "seller", "operator"] },
  confirmed: { courier_assigned: ["operator"], cancelled: ["buyer", "seller", "operator"] },
  courier_assigned: { picked_up: ["operator"], cancelled: ["operator"] },
  picked_up: { delivered: ["operator"], returned: ["operator"] },
  delivered: {},
  returned: {},
  cancelled: {},
};

export function canTransition(from: OrderStatus, to: OrderStatus, actor: OrderActor): boolean {
  return ORDER_TRANSITIONS[from]?.[to]?.includes(actor) ?? false;
}

/** Next steps the operator can take from a status (for bot buttons). */
export function operatorNextStatuses(from: OrderStatus): OrderStatus[] {
  return (Object.entries(ORDER_TRANSITIONS[from]) as Array<[OrderStatus, OrderActor[]]>)
    .filter(([, actors]) => actors.includes("operator"))
    .map(([to]) => to);
}

export const MAX_OPEN_ORDERS_PER_BUYER = 5;


// ---------- courier tariffs ----------

export interface CourierTariff {
  id: number;
  name: string;
  /** null = any district */
  fromDistrict: District | null;
  toDistrict: District | null;
  price: number;
  /** Extra fee for carrying cash (COD), percent of the item price. */
  codFeePct: number;
  active: boolean;
}

/** Most specific active tariff wins: exact pair → destination only → origin only → default. */
export function pickTariff(tariffs: CourierTariff[], from: District | null, to: District): CourierTariff | null {
  const active = tariffs.filter((t) => t.active);
  const score = (t: CourierTariff) => {
    if (t.fromDistrict && t.fromDistrict !== from) return -1;
    if (t.toDistrict && t.toDistrict !== to) return -1;
    return (t.fromDistrict ? 1 : 0) + (t.toDistrict ? 2 : 0);
  };
  let best: CourierTariff | null = null;
  for (const t of active) {
    const s = score(t);
    if (s >= 0 && (!best || s > score(best) || (s === score(best) && t.price < best.price))) best = t;
  }
  return best;
}

export interface DeliveryQuote {
  tariffId: number | null;
  deliveryFee: number;
  codFee: number;
  /** Delivery + COD fee paid by the buyer / by the seller (fee_payer). */
  buyerFee: number;
  sellerFee: number;
  itemPrice: number;
  /** What the buyer hands to the courier (COD) or pays in total (delivery only: item is paid to the seller directly). */
  buyerTotal: number;
  /** What the seller receives for the item after their share of fees. */
  sellerReceives: number;
}

const round1000 = (n: number) => Math.round(n / 1000) * 1000;

export function quoteDelivery(opts: {
  tariff: CourierTariff | null;
  itemPrice: number;
  mode: DeliveryMode;
  feePayer: FeePayer;
}): DeliveryQuote {
  const deliveryFee = opts.tariff?.price ?? 0;
  const codFee = opts.mode === "delivery_only" || !opts.tariff ? 0 : round1000((opts.itemPrice * opts.tariff.codFeePct) / 100);
  const fees = deliveryFee + codFee;
  const sellerFee = opts.feePayer === "seller" ? fees : opts.feePayer === "split" ? round1000(fees / 2) : 0;
  const buyerFee = fees - sellerFee;
  return {
    tariffId: opts.tariff?.id ?? null,
    deliveryFee,
    codFee,
    buyerFee,
    sellerFee,
    itemPrice: opts.itemPrice,
    buyerTotal: opts.itemPrice + buyerFee,
    sellerReceives: opts.itemPrice - sellerFee,
  };
}

/** Quote for a delivery with extra items of the same seller: the delivery fee is paid once. */
export interface BundleQuote {
  items: Array<{ listingId: string; quote: DeliveryQuote }>;
  /** Primary item + all extras, what the buyer pays in total. */
  buyerTotal: number;
  /** Delivery fees saved compared with separate orders. */
  saved: number;
}

export interface OrderEventDto {
  status: OrderStatus;
  at: string;
  note: string | null;
}

export interface OrderDto {
  id: string;
  status: OrderStatus;
  role: "buyer" | "seller" | "operator";
  mode: DeliveryMode;
  listing: { id: string; titleRu: string; titleUz: string; photoUrl: string | null };
  district: District;
  /** The buyer's address is shown only to the buyer and operators (never to the seller before pickup). */
  address: string | null;
  comment: string | null;
  quote: DeliveryQuote;
  feePayer: FeePayer;
  courier: { name: string | null } | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  history: OrderEventDto[];
  review: ReviewDto | null;
  canReview: boolean;
  /** Actions available to the viewer right now. */
  actions: Array<"confirm" | "decline" | "cancel" | "review">;
  /** Courier's inspection at pickup («Проверено Ishonch»), once done. */
  inspection: Inspection | null;
  /** Several items of the seller in one delivery: the other orders of the bundle. */
  bundle: Array<{ orderId: string; listingId: string; titleRu: string; titleUz: string; status: OrderStatus }>;
}

// ---------- reviews ----------


export interface ReviewDto {
  id: number;
  rating: number;
  text: string | null;
  createdAt: string;
}

export interface SellerRating {
  avg: number | null;
  count: number;
}

// ---------- complaints ----------

export const COMPLAINT_REASONS = ["scam", "prohibited", "wrong_info", "duplicate", "sold", "offensive", "other"] as const;
export type ComplaintReason = (typeof COMPLAINT_REASONS)[number];


/** Distinct users with open complaints needed to hide a listing until an admin reviews it (setting `complaints_to_hide`). */
export const DEFAULT_COMPLAINTS_TO_HIDE = 3;
export const MAX_COMPLAINTS_PER_DAY = 10;

// ---------- moderation ----------

export const MODERATION_REASONS = [
  "prohibited_item", // weapons, drugs, medicines, documents, counterfeit, stolen
  "contact_info", // phone, card, links or handles in the text
  "misleading", // text/photos/category don't match, bait price
  "offensive",
  "not_an_item", // services, jobs, spam
  "stock_photos",
  "duplicate_photos", // photos match another seller's listing
  "duplicate_text",
  "duplicate_imei", // the same IMEI in another seller's listing
  "complaints", // hidden after user complaints
  "other",
] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];


export type ModerationDecision = ListingModeration["decision"];

/** Stored on the listing (`listings.moderation`). */
export interface ModerationRecord {
  decision: ModerationDecision;
  source: "ai" | "rules" | "admin" | "complaints";
  reasons: Array<{ code: ModerationReason; note: string }>;
  sellerMessage?: { ru: string; uz: string };
  /** Listing ids that look like duplicates. */
  duplicates?: string[];
  /** Channels chosen at publication; posted once an admin approves a pending listing. */
  pendingChannelIds?: number[];
  at: string;
}

/** Max Hamming distance between 64-bit dHashes to call two photos the same picture. */
export const PHOTO_DUPLICATE_DISTANCE = 6;
export const TEXT_DUPLICATE_SIMILARITY = 0.85;

/** Days before expiry when the seller gets a "renew" reminder. */
export const EXPIRY_REMINDER_DAYS = 3;

