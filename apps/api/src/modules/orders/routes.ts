import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import {
  CreateOrderSchema,
  DELIVERY_MODES,
  InspectionInputSchema,
  MAX_BUNDLE_EXTRA,
  OfferInputSchema,
  ORDER_STATUSES,
  ReviewInputSchema,
  TASHKENT_DISTRICTS,
  t,
  type Lang,
} from "@ishonch/shared";
import type { User } from "../../db/schema.js";
import { OrderRejected, type OrderService } from "./service.js";

const MESSAGES: Record<string, string> = {
  not_found: "order.err.not_found",
  own_listing: "listing.own",
  not_available: "order.err.not_available",
  mode_not_allowed: "order.err.mode_not_allowed",
  phone_required: "order.err.phone_required",
  open_orders_limit: "order.err.open_orders_limit",
  already_ordered: "order.err.already_ordered",
  bad_state: "order.err.bad_state",
  review_exists: "order.err.review_exists",
  too_many_attempts: "order.err.too_many_attempts",
  offer_too_low: "offer.err.too_low",
  offer_not_lower: "offer.err.not_lower",
  offer_pending: "offer.err.pending",
  too_many_offers: "offer.err.too_many",
  bundle_invalid: "order.err.bundle_invalid",
  no_tariff: "order.err.no_tariff",
};

const TariffSchema = z.object({
  name: z.string().trim().min(1).max(100),
  fromDistrict: z.enum(TASHKENT_DISTRICTS).nullable(),
  toDistrict: z.enum(TASHKENT_DISTRICTS).nullable(),
  price: z.number().int().nonnegative().max(10_000_000),
  codFeePct: z.number().min(0).max(20),
  active: z.boolean().default(true),
});

export function orderRoutes(
  app: FastifyInstance,
  svc: OrderService,
  auth: { requireUser: preHandlerHookHandler; requireOperator: preHandlerHookHandler; requireAdmin: preHandlerHookHandler },
  audit: (actor: User, action: string, target: string | null, details?: Record<string, unknown>) => Promise<void>,
) {
  const { requireUser } = auth;

  async function handle<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OrderRejected) {
        const lang = (req.user?.language ?? "uz") as Lang;
        const key = MESSAGES[err.code];
        return reply.code(err.status).send({ error: err.code, message: key ? t(lang, key as Parameters<typeof t>[1]) : err.code });
      }
      throw err;
    }
  }

  app.get<{ Querystring: { listingId?: string } }>("/orders/bundle-candidates", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const id = z.string().uuid().safeParse(req.query.listingId);
      if (!id.success) return reply.code(400).send({ error: "bad_request" });
      return svc.bundleCandidates(req.user!, id.data);
    }),
  );

  app.get<{ Querystring: { listingId?: string; district?: string; mode?: string; extra?: string } }>(
    "/orders/quote",
    { preHandler: requireUser },
    (req, reply) =>
      handle(req, reply, async () => {
        const q = z
          .object({
            listingId: z.string().uuid(),
            district: z.enum(TASHKENT_DISTRICTS),
            mode: z.enum(DELIVERY_MODES),
            extra: z
              .string()
              .optional()
              .transform((s) => (s ? s.split(",") : []))
              .pipe(z.array(z.string().uuid()).max(MAX_BUNDLE_EXTRA)),
          })
          .safeParse(req.query);
        if (!q.success) return reply.code(400).send({ error: "bad_request" });
        return svc.quote(q.data.listingId, q.data.district, q.data.mode, req.user!.id, q.data.extra);
      }),
  );

  app.post("/orders", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const parsed = CreateOrderSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.issues });
      return svc.create(req.user!, parsed.data);
    }),
  );

  // ---- price offers ("торг"): buyer offers, seller answers with bot buttons ----
  const uuidParam = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
  app.get<{ Params: { id: string } }>("/listings/:id/offers/mine", { preHandler: requireUser }, async (req, reply) => {
    if (!uuidParam(req.params.id)) return reply.code(404).send({ error: "not_found" });
    return { offer: await svc.myOffer(req.user!, req.params.id) };
  });
  app.post<{ Params: { id: string } }>("/listings/:id/offers", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const parsed = OfferInputSchema.safeParse(req.body);
      if (!parsed.success || !uuidParam(req.params.id)) return reply.code(400).send({ error: "bad_request" });
      return svc.makeOffer(req.user!, req.params.id, parsed.data.amount);
    }),
  );
  app.post<{ Params: { id: string; decision: string } }>("/offers/:id/:decision", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const { decision } = req.params;
      if ((decision !== "accept" && decision !== "decline") || !uuidParam(req.params.id)) return reply.code(404).send({ error: "not_found" });
      return svc.decideOffer(req.user!, req.params.id, decision);
    }),
  );

  app.get<{ Querystring: { role?: string } }>("/orders/mine", { preHandler: requireUser }, (req) =>
    svc.mine(req.user!, req.query.role === "seller" ? "seller" : "buyer"),
  );

  app.get<{ Params: { id: string } }>("/orders/:id", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => svc.get(req.user!, req.params.id)),
  );

  // The bot calls confirm/decline/cancel with the user's identity (Internal auth) from inline buttons.
  app.post<{ Params: { id: string } }>("/orders/:id/confirm", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => svc.confirm(req.user!, req.params.id)),
  );
  app.post<{ Params: { id: string } }>("/orders/:id/decline", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => svc.decline(req.user!, req.params.id)),
  );
  app.post<{ Params: { id: string } }>("/orders/:id/cancel", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => svc.cancel(req.user!, req.params.id)),
  );
  app.post<{ Params: { id: string } }>("/orders/:id/review", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const parsed = ReviewInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      return svc.review(req.user!, req.params.id, parsed.data.rating, parsed.data.text);
    }),
  );

  app.get<{ Params: { id: string } }>("/sellers/:id/reviews", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    return svc.sellerReviews(req.params.id);
  });

  // ---- operators (Mini App/API or bot buttons in the operators' chat) ----
  app.get<{ Querystring: { status?: string } }>("/operator/orders", { preHandler: auth.requireOperator }, (req) => {
    const status = (ORDER_STATUSES as readonly string[]).includes(req.query.status ?? "")
      ? (req.query.status as (typeof ORDER_STATUSES)[number])
      : undefined;
    return svc.operatorList(status);
  });

  app.post<{ Params: { id: string } }>("/operator/orders/:id/status", { preHandler: auth.requireOperator }, (req, reply) =>
    handle(req, reply, async () => {
      const parsed = z
        .object({
          status: z.enum(ORDER_STATUSES),
          note: z.string().trim().max(300).optional(),
          courierName: z.string().trim().max(100).optional(),
          courierPhone: z.string().trim().max(30).optional(),
          wholeBundle: z.boolean().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const { status, ...extra } = parsed.data;
      const res = await svc.operatorSetStatus(req.user!, req.params.id, status, extra);
      await audit(req.user!, `order.${status}`, req.params.id, extra);
      return res;
    }),
  );

  app.post<{ Params: { id: string } }>("/operator/orders/:id/inspection", { preHandler: auth.requireOperator }, (req, reply) =>
    handle(req, reply, async () => {
      const parsed = InspectionInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const res = await svc.inspect(req.user!, req.params.id, parsed.data);
      await audit(req.user!, "order.inspection", req.params.id, { passed: res.inspection?.passed ?? null });
      return res;
    }),
  );

  // ---- tariffs ----
  app.get("/admin/tariffs", { preHandler: auth.requireAdmin }, () => svc.tariffs());
  app.put("/admin/tariffs", { preHandler: auth.requireAdmin }, async (req, reply) => {
    const parsed = z.array(TariffSchema).max(200).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.issues });
    const res = await svc.replaceTariffs(parsed.data);
    await audit(req.user!, "tariffs.replace", null, { rows: parsed.data.length });
    return res;
  });
}
