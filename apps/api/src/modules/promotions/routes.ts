import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { PROMO_PLANS, t, type Lang } from "@ishonch/shared";
import { PromotionRejected, type PromotionService } from "./service.js";

const MESSAGES: Record<string, string> = {
  promotion_disabled: "promo.err.disabled",
  not_found: "promo.err.not_found",
  forbidden: "promo.err.not_found",
  not_active: "promo.err.not_active",
  bad_payment: "promo.err.bad_payment",
};

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const PaymentSchema = z.object({
  payload: z.string().max(128),
  currency: z.string().max(8).default("XTR"),
  amount: z.number().int().nonnegative(),
  chargeId: z.string().min(1).max(256).optional(),
});

export function promotionRoutes(
  app: FastifyInstance,
  svc: PromotionService,
  auth: { requireUser: preHandlerHookHandler; requireInternal: preHandlerHookHandler; requireAdmin: preHandlerHookHandler },
) {
  async function handle<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PromotionRejected) {
        const lang = (req.user?.language ?? "uz") as Lang;
        return reply.code(err.status).send({ error: err.code, message: t(lang, MESSAGES[err.code] as Parameters<typeof t>[1]) });
      }
      throw err;
    }
  }

  app.get("/promotion/options", () => svc.options());

  app.post<{ Params: { id: string } }>("/listings/:id/promote", { preHandler: auth.requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const body = z.object({ plan: z.enum(PROMO_PLANS) }).safeParse(req.body);
      if (!isUuid(req.params.id) || !body.success) return reply.code(400).send({ error: "bad_request" });
      return svc.start(req.user!, req.params.id, body.data.plan);
    }),
  );

  // The bot forwards Telegram's payment updates (pre_checkout_query, successful_payment) for the paying user.
  app.post("/internal/payments/precheck", { preHandler: auth.requireInternal }, async (req, reply) => {
    const body = PaymentSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_request" });
    return svc.precheck(req.user!, body.data.payload, body.data.currency, body.data.amount);
  });
  app.post("/internal/payments/paid", { preHandler: auth.requireInternal }, (req, reply) =>
    handle(req, reply, async () => {
      const body = PaymentSchema.safeParse(req.body);
      if (!body.success || !body.data.chargeId) return reply.code(400).send({ error: "bad_request" });
      return svc.paid(req.user!, body.data.payload, body.data.amount, body.data.chargeId);
    }),
  );

  app.get("/admin/promotions", { preHandler: auth.requireAdmin }, () => svc.recent());
  app.post<{ Params: { id: string } }>("/admin/promotions/:id/refund", { preHandler: auth.requireAdmin }, (req, reply) =>
    handle(req, reply, async () => {
      if (!isUuid(req.params.id)) return reply.code(404).send({ error: "not_found" });
      return svc.refund(req.user!, req.params.id);
    }),
  );
}
