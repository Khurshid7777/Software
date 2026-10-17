import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { GUARANTEE_DAYS, LANGS, NOTIFY_TYPES, t, type Lang, type NotifyType } from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import type { CheckService } from "../checks/service.js";

export function userRoutes(
  app: FastifyInstance,
  repo: Repo,
  checks: CheckService,
  requireUser: preHandlerHookHandler,
  /** Removes the user's files (listing photos, videos, shop photo) before the rows go. */
  purgeFiles: (userId: string) => Promise<void> = async () => undefined,
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
      createdAt: u.createdAt,
      checks: limit,
    };
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
