import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ComplaintInputSchema, t, type Lang } from "@ishonch/shared";
import { TrustRejected, type TrustService } from "./service.js";

const MESSAGES: Record<string, string> = {
  not_found: "listing.not_found",
  own_listing: "listing.own",
  complaint_limit: "complaint.limit",
};

export function trustRoutes(
  app: FastifyInstance,
  svc: TrustService,
  auth: { requireUser: preHandlerHookHandler; requireAdmin: preHandlerHookHandler },
) {
  async function handle<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TrustRejected) {
        const key = MESSAGES[err.code];
        const lang = (req.user?.language ?? "uz") as Lang;
        return reply.code(err.status).send({ error: err.code, message: key ? t(lang, key as Parameters<typeof t>[1]) : err.code });
      }
      throw err;
    }
  }

  const uuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

  app.post<{ Params: { id: string } }>("/listings/:id/complaints", { preHandler: auth.requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      if (!uuid(req.params.id)) throw new TrustRejected("not_found", 404);
      const parsed = ComplaintInputSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      return svc.complain(req.user!, req.params.id, parsed.data.reason, parsed.data.text);
    }),
  );

  // ---- admin: moderation queue, complaints, bans ----
  app.get("/admin/moderation", { preHandler: auth.requireAdmin }, () => svc.queue());
  app.get<{ Querystring: { all?: string } }>("/admin/complaints", { preHandler: auth.requireAdmin }, (req) =>
    svc.listComplaints(req.query.all !== "true"),
  );

  // Also called by the bot from the moderators' chat buttons (Internal auth as the clicking admin).
  app.post<{ Params: { id: string } }>("/admin/listings/:id/moderate", { preHandler: auth.requireAdmin }, (req, reply) =>
    handle(req, reply, async () => {
      if (!uuid(req.params.id)) throw new TrustRejected("not_found", 404);
      const parsed = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(40).optional() }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      return svc.decide(req.user!, req.params.id, parsed.data.decision, parsed.data.reason);
    }),
  );

  app.get<{ Querystring: { telegramId?: string; id?: string } }>("/admin/users", { preHandler: auth.requireAdmin }, async (req, reply) => {
    const id = req.query.id && uuid(req.query.id) ? req.query.id : undefined;
    const telegramId = Number(req.query.telegramId) || undefined;
    const u = await svc.findUser({ id, telegramId });
    return u ?? reply.code(404).send({ error: "not_found" });
  });

  app.post<{ Params: { id: string } }>("/admin/users/:id/ban", { preHandler: auth.requireAdmin }, (req, reply) =>
    handle(req, reply, async () => {
      if (!uuid(req.params.id)) throw new TrustRejected("not_found", 404);
      const parsed = z.object({ reason: z.string().trim().min(3).max(300) }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      return svc.ban(req.user!, req.params.id, parsed.data.reason);
    }),
  );

  app.post<{ Params: { id: string } }>("/admin/users/:id/unban", { preHandler: auth.requireAdmin }, (req, reply) =>
    handle(req, reply, async () => {
      if (!uuid(req.params.id)) throw new TrustRejected("not_found", 404);
      return svc.unban(req.user!, req.params.id);
    }),
  );
}
