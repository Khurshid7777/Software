import { z } from "zod";

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

export interface FunnelStep {
  step: string;
  users: number;
  /** Relative to the previous step; null for the first step or when the previous step is 0. */
  conversionPct: number | null;
}

export interface AdminMetrics {
  period: { from: string; to: string; days: number };
  users: { total: number; new: number; active: number; sellers: number; banned: number };
  checks: { users: number };
  buyerFunnel: FunnelStep[];
  sellerFunnel: FunnelStep[];
  listings: {
    active: number;
    pending: number;
    reserved: number;
    published: number;
    sold: number;
    soldPlatform: number;
    moderation: { approved: number; needsReview: number; rejected: number };
    complaints: { open: number; period: number; hiddenListings: number };
  };
  orders: {
    created: number;
    open: number;
    delivered: number;
    returned: number;
    cancelled: number;
    returnRatePct: number | null;
    gmvUzs: number;
    deliveryFeesUzs: number;
    avgHoursToDeliver: number | null;
    stuckOver24h: number;
    cancelReasons: Array<{ reason: string; count: number }>;
    byMode: Array<{ mode: string; count: number; delivered: number }>;
  };
  ai: {
    periodUsd: number;
    monthUsd: number;
    monthlyLimitUsd: number;
    byFeature: Array<{ feature: string; calls: number; usd: number }>;
  };
  daily: Array<{ date: string; newUsers: number; checks: number; published: number; orders: number; delivered: number; aiUsd: number }>;
}
