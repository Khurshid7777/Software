import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { LANGS, t, type Lang } from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import type { CheckService } from "../checks/service.js";

export function userRoutes(
  app: FastifyInstance,
  repo: Repo,
  checks: CheckService,
  requireUser: preHandlerHookHandler,
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

  app.delete("/me", { preHandler: requireUser }, async (req, reply) => {
    // Orders reference both sides; deleting mid-delivery would erase a courier's cash record.
    if (await repo.hasOpenOrders(req.user!.id)) {
      return reply.code(409).send({ error: "open_orders", message: t(req.user!.language as Lang, "home.delete_open_orders") });
    }
    await repo.deleteUser(req.user!.id);
    return { ok: true };
  });
}
