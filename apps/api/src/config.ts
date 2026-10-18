import { z } from "zod";

const csvNumbers = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(Number),
  );

/** Optional number where an empty value (`OPERATOR_CHAT_ID=`) means "not set". */
const optionalNumber = z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().optional());

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default("postgres://ishonch:ishonch@localhost:5432/ishonch"),
  BOT_TOKEN: z.string().default(""),
  INTERNAL_API_TOKEN: z.string().default("dev-internal-token"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL_FAST: z.string().default("claude-haiku-5-5"),
  AI_MODEL_STRONG: z.string().default("claude-opus-5-5"),
  AI_MONTHLY_LIMIT_USD: z.coerce.number().default(50),
  // Part of the monthly limit the strong model (buyer assistant) may use.
  AI_STRONG_MONTHLY_LIMIT_USD: z.coerce.number().default(20),
  CHECKS_PER_DAY: z.coerce.number().default(5),
  ASSISTANT_PER_DAY: z.coerce.number().default(10),
  USD_RATE: z.coerce.number().default(12800),
  ADMIN_TELEGRAM_IDS: csvNumbers,
  // Delivery operators (role "operator"): change order statuses via bot buttons.
  OPERATOR_TELEGRAM_IDS: csvNumbers,
  // Telegram group for operators (confirmed orders with addresses and phones). Empty: DM each operator.
  OPERATOR_CHAT_ID: optionalNumber,
  // Telegram group for moderators (pending listings, complaints). Empty: DM each admin.
  MODERATION_CHAT_ID: optionalNumber,
  // Courier integration. Only "manual" exists: operators arrange couriers themselves.
  COURIER_PROVIDER: z.enum(["manual"]).default("manual"),
  // Hour (Tashkent, 0-23) of the daily digest to admins; empty or -1 turns it off.
  DIGEST_HOUR: z.preprocess((v) => (v === "" ? -1 : v), z.coerce.number().int().min(-1).max(23).default(9)),
  // AI pre-moderation of listings at publication. "false": rules and duplicate checks only.
  AI_MODERATION: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  // How long a Mini App launch stays valid; a leaked initData can be replayed only within this window.
  INIT_DATA_MAX_AGE_SEC: z.coerce.number().default(4 * 3600),
  /** Shown by /health (set to the git commit or release tag at deploy). */
  APP_VERSION: z.string().default("dev"),
  // Per-user request limits (off in tests unless set explicitly).
  RATE_LIMITS: z.enum(["on", "off"]).optional(),
  // Shared rate-limit counters for several API replicas (redis://host:6379). Empty: in-memory per instance.
  REDIS_URL: z.string().default(""),
  // Behind nginx: take the client IP from X-Forwarded-For.
  TRUST_PROXY: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  CORS_ORIGIN: z.string().default("*"),
  LOG_FILE: z.string().optional(),
  // Photo storage: "s3" (MinIO) in production, "fs" for local development and tests.
  STORAGE_DRIVER: z.enum(["s3", "fs"]).default("fs"),
  STORAGE_DIR: z.string().default("./data/storage"),
  MINIO_ENDPOINT: z.string().default("http://localhost:9000"),
  MINIO_ROOT_USER: z.string().default("ishonch"),
  MINIO_ROOT_PASSWORD: z.string().default("ishonch-secret"),
  MINIO_BUCKET: z.string().default("ishonch-photos"),
  // Speech-to-text (Whisper-compatible HTTP API). Empty STT_URL disables voice input.
  STT_URL: z.string().default(""),
  STT_API_KEY: z.string().optional(),
  STT_MODEL: z.string().default("whisper-1"),
  // e.g. https://t.me/ishonch_bot/app ; when empty, https://t.me/<bot>?startapp=... is used
  MINIAPP_LINK: z.string().optional(),
  PHOTO_URL_SECRET: z.string().optional(),
  COD_PLATFORM_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // Optional notifications wait from 22:00 to 08:00 Tashkent. Off by default only in tests (time-of-day independent).
  QUIET_HOURS: z.enum(["true", "false"]).optional(),
});

export type Config = Omit<z.infer<typeof EnvSchema>, "QUIET_HOURS"> & { QUIET_HOURS: boolean };

const WEAK_SECRETS = new Set(["dev-internal-token", "change-me-long-random", ""]);

/**
 * Settings that work but are unsafe on a public server: logged loudly at start (not fatal, so an
 * existing deployment keeps running while they are fixed).
 */
export function productionWarnings(config: Config): string[] {
  if (config.NODE_ENV !== "production") return [];
  const out: string[] = [];
  if (/:\/\/[^:]+:(ishonch)?@/.test(config.DATABASE_URL)) out.push("DATABASE_URL uses the default database password: set POSTGRES_PASSWORD");
  if (config.STORAGE_DRIVER === "s3" && config.MINIO_ROOT_PASSWORD === "ishonch-secret") out.push("MINIO_ROOT_PASSWORD is the default one");
  if (config.CORS_ORIGIN === "*") out.push("CORS_ORIGIN=* lets any site call the API: set it to the Mini App origin");
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.parse(env);
  const config = { ...parsed, QUIET_HOURS: (parsed.QUIET_HOURS ?? (parsed.NODE_ENV === "test" ? "false" : "true")) === "true" };
  if (config.NODE_ENV === "production") {
    // The internal token lets the bot act as any user, admins included: never start with a placeholder.
    if (WEAK_SECRETS.has(config.INTERNAL_API_TOKEN) || config.INTERNAL_API_TOKEN.length < 32) {
      throw new Error("INTERNAL_API_TOKEN must be a random string of at least 32 characters in production");
    }
    if (!config.BOT_TOKEN) throw new Error("BOT_TOKEN is required in production");
  }
  return config;
}
