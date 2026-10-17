

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
  /** Stage 21: deals that happen in person — contact → meeting asked → agreed → bought. */
  meetingFunnel: FunnelStep[];
  /** Stage 21: what people searched for and found nothing (most frequent first) — gaps in supply or spelling. */
  searchMisses: Array<{ q: string; count: number; users: number }>;
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
  /** Background jobs: waiting now, and given up after all retries (need a look). */
  system: { queuedJobs: number; failedJobs: number; openDisputes: number };
}
