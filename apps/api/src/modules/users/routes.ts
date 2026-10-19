import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { eq } from "drizzle-orm";
import { AWAY_MAX_DAYS, GUARANTEE_DAYS, LANGS, NOTIFY_TYPES, t, type Lang, type NotifyType } from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import { users } from "../../db/schema.js";
import type { Notifier } from "../../telegram/publisher.js";
import { buildExport } from "./export.js";
import type { CheckService } from "../checks/service.js";

export function userRoutes(
  app: FastifyInstance,
  repo: Repo,
  checks: CheckService,
  requireUser: preHandlerHookHandler,
  /** Removes the user's files (listing photos, videos, shop photo) before the rows go. */
  purgeFiles: (userId: string) => Promise<void> = async () => undefined,
  /** Sends «Скачать мои данные» as a file in the bot chat. */
  notifier: Notifier | null = null,
) {
  app.get("/me", { preHandler: requireUser }, async (req) => {
    const u = req.user!;
    const limit = await checks.limitInfo(u);
    return {
      id: u.id,
      telegramId: u.telegramId,
      language: u.language,
      role: u.role,
      acceptedTerms: u.acceptedTermsAt !== null,
      hasPhone: !!u.phone,
      notifyOff: u.notifyOff,
      awayUntil: u.awayUntil && u.awayUntil > new Date() ? u.awayUntil.toISOString() : null,
      createdAt: u.createdAt,
      checks: limit,
    };
  });

  // «Скачать мои данные» (stage 29): once a day, as a JSON file in the chat with the bot.
  app.post("/me/export", { preHandler: requireUser }, async (req, reply) => {
    const u = req.user!;
    const lang = u.language as Lang;
    if (!notifier?.sendDocument) return reply.code(503).send({ error: "export_unavailable", message: t(lang, "export.unavailable") });
    const reservation = await repo.reserveDaily(u.id, "data_export", 1);
    if (reservation == null) return reply.code(429).send({ error: "export_limit", message: t(lang, "export.limit") });
    try {
      const data = Buffer.from(JSON.stringify(await buildExport(repo, u), null, 2));
      await notifier.sendDocument(u.telegramId, { name: `ishonch-data-${new Date().toISOString().slice(0, 10)}.json`, data }, t(lang, "export.caption"));
    } catch (err) {
      await repo.refundDaily(reservation);
      throw err;
    }
    return { sent: true };
  });

  // «В отъезде» (stage 28): until a date at most AWAY_MAX_DAYS ahead; null — back now.
  app.put<{ Body: { until?: string | null } }>("/me/away", { preHandler: requireUser }, async (req, reply) => {
    const raw = req.body?.until ?? null;
    const until = raw === null ? null : new Date(raw);
    const now = Date.now();
    if (until && (Number.isNaN(until.getTime()) || until.getTime() <= now || until.getTime() > now + AWAY_MAX_DAYS * 86_400_000)) {
      return reply.code(400).send({ error: "bad_date" });
    }
    await repo.db.update(users).set({ awayUntil: until }).where(eq(users.id, req.user!.id));
    await repo.event(req.user!.id, until ? "away_on" : "away_off");
    return { awayUntil: until?.toISOString() ?? null };
  });

  app.post("/me/accept-terms", { preHandler: requireUser }, async (req) => {
    await repo.acceptTerms(req.user!.id);
    await repo.event(req.user!.id, "terms_accepted");
    return { ok: true };
  });

  app.patch<{ Body: { language?: string } }>("/me", { preHandler: requireUser }, async (req, reply) => {
    const lang = req.body?.language as Lang | undefined;
    if (!lang || !LANGS.includes(lang)) return reply.code(400).send({ error: "bad_language" });
    await repo.setLanguage(req.user!.id, lang);
    return { ok: true, language: lang };
  });

  // Stage 20: switch an optional notification type on or off (Mini App settings and the bot's «Не присылать»).
  app.patch<{ Body: { type?: string; on?: boolean } }>("/me/notifications", { preHandler: requireUser }, async (req, reply) => {
    const type = req.body?.type as NotifyType | undefined;
    if (!type || !NOTIFY_TYPES.includes(type) || typeof req.body?.on !== "boolean") return reply.code(400).send({ error: "bad_request" });
    const notifyOff = await repo.setNotify(req.user!.id, type, req.body.on);
    await repo.event(req.user!.id, req.body.on ? "notify_on" : "notify_off", { type });
    return { notifyOff };
  });

  app.delete("/me", { preHandler: requireUser }, async (req, reply) => {
    // Orders reference both sides; deleting mid-delivery would erase a courier's cash record.
    if (await repo.hasOpenOrders(req.user!.id, GUARANTEE_DAYS)) {
      return reply.code(409).send({ error: "open_orders", message: t(req.user!.language as Lang, "home.delete_open_orders", { days: GUARANTEE_DAYS }) });
    }
    await purgeFiles(req.user!.id).catch((err) => req.log.error({ err }, "purging files failed"));
    await repo.deleteUser(req.user!.id);
    return { ok: true };
  });
}
