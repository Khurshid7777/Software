import Anthropic from "@anthropic-ai/sdk";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import type { Config } from "./config.js";
import { AiService } from "./ai/aiService.js";
import { makeAuth } from "./auth/plugin.js";
import { Repo } from "./db/repo.js";
import type { Db } from "./db/client.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { checkRoutes, multipartLimits } from "./modules/checks/routes.js";
import { CheckService } from "./modules/checks/service.js";
import { userRoutes } from "./modules/users/routes.js";
import { listingRoutes, MAX_UPLOAD_BYTES } from "./modules/listings/routes.js";
import { LISTING_AI_PER_DAY, ListingService } from "./modules/listings/service.js";
import { ShopService } from "./modules/shops/service.js";
import { FsStorage, S3Storage, type Storage } from "./storage/storage.js";
import { DisabledSpeechToText, HttpWhisperSpeechToText, type SpeechToText } from "./stt/speechToText.js";
import { BotApiPublisher, type ChannelPublisher, type Notifier } from "./telegram/publisher.js";
import { AssistantService } from "./modules/catalog/assistant.js";
import { catalogRoutes } from "./modules/catalog/routes.js";
import { CatalogService } from "./modules/catalog/service.js";
import { MetricsService } from "./modules/metrics/service.js";
import { ModerationService } from "./modules/moderation/service.js";
import { createCourierProvider, type CourierProvider } from "./modules/orders/courier.js";
import { orderRoutes } from "./modules/orders/routes.js";
import { OrderService } from "./modules/orders/service.js";
import { trustRoutes } from "./modules/trust/routes.js";
import { TrustService } from "./modules/trust/service.js";
import { StaffNotifier } from "./telegram/staff.js";
import { maybeSendDigest } from "./jobs.js";
import { JobQueue } from "./jobs/queue.js";
import { registerRateLimits } from "./rateLimit.js";
import { DEFAULT_COMPLAINTS_TO_HIDE } from "@ishonch/shared";

export interface AppDeps {
  config: Config;
  db: Db;
  /** Injected in tests; defaults to the real Anthropic client. */
  ai?: Pick<AiService, "structured">;
  storage?: Storage;
  stt?: SpeechToText;
  publisher?: (ChannelPublisher & Notifier) | null;
  courier?: CourierProvider;
  /** true in server.ts: jobs go to the queue and a worker runs them. Tests and dev run them inline. */
  backgroundJobs?: boolean;
}

export function createStorage(config: Config): Storage {
  return config.STORAGE_DRIVER === "s3"
    ? new S3Storage(config.MINIO_BUCKET, {
        endpoint: config.MINIO_ENDPOINT,
        accessKeyId: config.MINIO_ROOT_USER,
        secretAccessKey: config.MINIO_ROOT_PASSWORD,
      })
    : new FsStorage(config.STORAGE_DIR);
}

export async function buildApp({ config, db, ai, storage, stt, publisher, courier, backgroundJobs = false }: AppDeps) {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
      // Always to stdout (docker logs); with LOG_FILE also to a file (rotate it with logrotate on the host).
      ...(config.LOG_FILE
        ? {
            transport: {
              targets: [
                { target: "pino/file", options: { destination: 1 } },
                { target: "pino/file", options: { destination: config.LOG_FILE, mkdir: true } },
              ],
            },
          }
        : {}),
      redact: ["req.headers.authorization", 'req.headers["x-telegram-user"]'],
    },
    bodyLimit: 1024 * 1024,
    trustProxy: config.TRUST_PROXY,
  });
  if ((config.RATE_LIMITS ?? (config.NODE_ENV === "test" ? "off" : "on")) === "on") await registerRateLimits(app);
  await app.register(cors, { origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN.split(",") });
  await app.register(multipart, {
    limits: { ...multipartLimits, files: 12, fileSize: Math.max(multipartLimits.fileSize, MAX_UPLOAD_BYTES) },
  });
  // Malformed ids in the URL (not a uuid / not a number) reach PostgreSQL as invalid input: that is a 404, not a 500.
  app.setErrorHandler((err, req, reply) => {
    const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
    if (code === "22P02" || code === "22003") return reply.code(404).send({ error: "not_found" });
    const status = (err as { statusCode?: number }).statusCode;
    // Client errors keep their status (plugins such as rate-limit throw plain objects, not Errors).
    if (status && status < 500) return reply.code(status).send(err);
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: "internal" });
  });
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) => done(null, body));

  const repo = new Repo(db, config.ADMIN_TELEGRAM_IDS, config.OPERATOR_TELEGRAM_IDS);
  const aiService =
    ai ??
    new AiService({
      client: new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 }),
      models: { fast: config.AI_MODEL_FAST, strong: config.AI_MODEL_STRONG },
      recordUsage: (u) => repo.recordAiUsage(u),
      monthlySpend: () => repo.aiBudget(),
      addSpend: (tier, usd) => repo.addAiSpend(tier, usd),
      monthlyLimitUsd: () => repo.getSetting("ai_monthly_limit_usd", config.AI_MONTHLY_LIMIT_USD),
      strongLimitUsd: () => repo.getSetting("ai_strong_monthly_limit_usd", config.AI_STRONG_MONTHLY_LIMIT_USD),
      logger: app.log,
    });

  const auth = makeAuth({
    repo,
    botToken: config.BOT_TOKEN,
    internalToken: config.INTERNAL_API_TOKEN,
    maxAgeSec: config.INIT_DATA_MAX_AGE_SEC,
  });
  const gateway =
    publisher !== undefined ? publisher : config.BOT_TOKEN ? new BotApiPublisher(config.BOT_TOKEN, config.MINIAPP_LINK) : null;
  // eslint-disable-next-line prefer-const
  let catalog: CatalogService;
  const checks = new CheckService(
    repo,
    aiService,
    { checksPerDay: config.CHECKS_PER_DAY, usdRate: config.USD_RATE },
    (key) => catalog.findCatalogPrice(key),
  );

  const queue = new JobQueue(db, { inline: !backgroundJobs, logger: app.log });
  const store = storage ?? createStorage(config);
  const shopsSvc = new ShopService(repo, store);
  const staff = new StaffNotifier(gateway, {
    operators: { chatId: config.OPERATOR_CHAT_ID, userIds: [...config.OPERATOR_TELEGRAM_IDS, ...config.ADMIN_TELEGRAM_IDS] },
    moderators: { chatId: config.MODERATION_CHAT_ID, userIds: config.ADMIN_TELEGRAM_IDS },
    admins: { userIds: config.ADMIN_TELEGRAM_IDS },
  });
  const moderation = new ModerationService({
    repo,
    ai: config.AI_MODERATION ? aiService : null,
    storage: store,
    findMarket: async (key) => (await repo.findReferencePrice(key)) ?? (await catalog.findCatalogPrice(key)),
    logger: app.log,
  });
  const listingsSvc = new ListingService({
    repo,
    ai: aiService,
    storage: store,
    stt:
      stt ??
      (config.STT_URL
        ? new HttpWhisperSpeechToText({ url: config.STT_URL, apiKey: config.STT_API_KEY, model: config.STT_MODEL })
        : new DisabledSpeechToText()),
    publisher: gateway,
    notifier: gateway,
    staff,
    moderation,
    enqueue: (kind, payload) => queue.enqueue(kind, payload),
    onPublished: (id) => catalog.notifySavedSearches(id),
    onUnavailable: (id, reason): Promise<number> => ordersSvc.closeNewOrders(id, reason),
    photoSecret: config.PHOTO_URL_SECRET || `${config.INTERNAL_API_TOKEN}:photos`,
    usdRate: config.USD_RATE,
    codPlatformEnabled: config.COD_PLATFORM_ENABLED,
  });

  catalog = new CatalogService(repo, listingsSvc, gateway);
  const assistant = new AssistantService(repo, catalog, aiService, {
    perDay: config.ASSISTANT_PER_DAY,
    usdRate: config.USD_RATE,
  });

  const ordersSvc: OrderService = new OrderService({
    repo,
    listings: listingsSvc,
    notifier: gateway,
    staff,
    courier: courier ?? createCourierProvider(config.COURIER_PROVIDER),
    codPlatformEnabled: config.COD_PLATFORM_ENABLED,
  });
  const trust = new TrustService({ repo, listings: listingsSvc, onBanned: (id) => ordersSvc.cancelAllFor(id) });

  app.get("/health", async () => ({ ok: true }));
  userRoutes(app, repo, checks, auth.requireUser);
  checkRoutes(app, checks, auth.requireUser);
  const metrics = new MetricsService(repo);
  const adminLink = () => (gateway ? gateway.miniAppLink("screen_admin").catch(() => null) : Promise.resolve(null));
  adminRoutes(app, repo, auth.requireRole("admin"), {
    metrics,
    settingDefaults: {
      checks_per_day: config.CHECKS_PER_DAY,
      assistant_per_day: config.ASSISTANT_PER_DAY,
      usd_rate: config.USD_RATE,
      ai_monthly_limit_usd: config.AI_MONTHLY_LIMIT_USD,
      ai_strong_monthly_limit_usd: config.AI_STRONG_MONTHLY_LIMIT_USD,
      complaints_to_hide: DEFAULT_COMPLAINTS_TO_HIDE,
      listing_ai_per_day: LISTING_AI_PER_DAY,
    },
    sendDigest: async () => {
      const link = await adminLink();
      return staff.admins(await metrics.digest(), link ? [[{ text: "Открыть админку", url: link }]] : []);
    },
  });
  listingRoutes(app, listingsSvc, shopsSvc, repo, {
    requireUser: auth.requireUser,
    requireInternal: auth.requireInternal,
    optionalUser: auth.optionalUser,
    requireAdmin: auth.requireRole("admin"),
  });
  orderRoutes(app, ordersSvc, {
    requireUser: auth.requireUser,
    requireOperator: auth.requireRole("operator", "admin"),
    requireAdmin: auth.requireRole("admin"),
  }, (actor, action, target, details) => repo.audit(actor, action, target, details));
  trustRoutes(app, trust, { requireUser: auth.requireUser, requireAdmin: auth.requireRole("admin") });
  catalogRoutes(app, catalog, assistant, {
    requireUser: auth.requireUser,
    requireInternal: auth.requireInternal,
    optionalUser: auth.optionalUser,
  });

  for (const kind of ["channel_posts", "saved_search_alerts"]) queue.register(kind, (p) => listingsSvc.runJob(kind, p));

  app.decorate("services", {
    queue,
    listings: listingsSvc,
    orders: ordersSvc,
    trust,
    metrics,
    digest: (now?: Date) => maybeSendDigest({ repo, metrics, staff, adminLink }, config.DIGEST_HOUR, now),
  });
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    services: {
      queue: JobQueue;
      listings: ListingService;
      orders: OrderService;
      trust: TrustService;
      metrics: MetricsService;
      digest: (now?: Date) => Promise<boolean>;
    };
  }
}
