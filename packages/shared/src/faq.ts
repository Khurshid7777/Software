// «Вопросы и ответы»: the structure (groups, order, the button an answer may carry). The texts live in the
// dictionaries as faq.<id>.q / faq.<id>.a, so both languages are checked like everything else.
export const FAQ_GROUPS = [
  { id: "buying", items: ["find", "grades", "passport", "compare", "forecast", "price", "offer", "trade", "chat", "favorites", "wanted"] },
  { id: "money", items: ["money", "fee", "paymodes", "deliveryfee", "prepay", "cashless", "installments"] },
  { id: "delivery", items: ["how_order", "timing", "inspection", "notfit", "cancel", "bigitems", "bundle", "meet"] },
  { id: "protection", items: ["refund", "dispute_how", "payback", "complain", "address"] },
  { id: "safety", items: ["scam", "check", "stolen", "imei_check", "imei_reg", "seller", "reviews", "ai"] },
  { id: "video", items: ["video", "video_how", "video_required", "imei_why", "imei_mismatch", "video_privacy"] },
  { id: "selling", items: ["sell_how", "sell_price", "sell_rules", "sell_moderation", "sell_limit", "sell_life", "sell_orders", "sell_money", "sell_dispute", "sell_away", "shop"] },
  { id: "account", items: ["lang", "notifications", "export", "contact"] },
] as const;

export type FaqGroupId = (typeof FAQ_GROUPS)[number]["id"];
export type FaqId = (typeof FAQ_GROUPS)[number]["items"][number];
export const FAQ_IDS: readonly FaqId[] = FAQ_GROUPS.flatMap((g) => g.items) as FaqId[];
export const isFaqId = (v: unknown): v is FaqId => typeof v === "string" && (FAQ_IDS as readonly string[]).includes(v);

/** Where an answer's own button leads. */
export const FAQ_ACTION_KINDS = ["catalog", "compare", "valuation", "inspect", "check", "imei", "sell"] as const;
export type FaqAction = (typeof FAQ_ACTION_KINDS)[number];
export const FAQ_ACTIONS: Partial<Record<FaqId, FaqAction>> = {
  find: "catalog",
  compare: "compare",
  price: "valuation",
  prepay: "check",
  inspection: "inspect",
  meet: "catalog",
  scam: "check",
  check: "check",
  stolen: "imei",
  sell_how: "sell",
  sell_price: "valuation",
};
