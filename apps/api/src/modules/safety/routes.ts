import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { CHAT_REPORT_REASONS } from "@ishonch/shared";
import { SafetyRejected, type SafetyService } from "./service.js";

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export function safetyRoutes(
  app: FastifyInstance,
  svc: SafetyService,
  auth: { requireUser: preHandlerHookHandler; requireInternal: preHandlerHookHandler; requireAdmin: preHandlerHookHandler },
) {
  async function handle<T>(_req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SafetyRejected) return reply.code(err.status).send({ error: err.code });
      throw err;
    }
  }

  // The masked chat lives in the bot: its buttons call these for the pressing user.
  app.post<{ Params: { id: string } }>("/internal/conversations/:id/block", { preHandler: auth.requireInternal }, (req, reply) =>
    handle(req, reply, async () => {
      if (!isUuid(req.params.id)) return reply.code(404).send({ error: "not_found" });
      return svc.block(req.user!, req.params.id);
    }),
  );
  app.post<{ Params: { id: string } }>("/internal/conversations/:id/report", { preHandler: auth.requireInternal }, (req, reply) =>
    handle(req, reply, async () => {
      const body = z.object({ reason: z.enum(CHAT_REPORT_REASONS) }).safeParse(req.body);
      if (!isUuid(req.params.id) || !body.success) return reply.code(400).send({ error: "bad_request" });
      return svc.report(req.user!, req.params.id, body.data.reason);
    }),
  );

  app.get("/me/blocks", { preHandler: auth.requireUser }, (req) => svc.blocks(req.user!));
  app.delete<{ Params: { userId: string } }>("/me/blocks/:userId", { preHandler: auth.requireUser }, (req, reply) =>
    isUuid(req.params.userId) ? svc.unblock(req.user!, req.params.userId) : reply.code(404).send({ error: "not_found" }),
  );

  app.get("/admin/chat-reports", { preHandler: auth.requireAdmin }, () => svc.openReports());
  app.post<{ Params: { id: string } }>("/admin/chat-reports/:id/resolve", { preHandler: auth.requireAdmin }, (req, reply) =>
    handle(req, reply, async () => {
      const body = z.object({ resolution: z.enum(["dismissed", "warned", "banned"]) }).safeParse(req.body);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || !body.success) return reply.code(400).send({ error: "bad_request" });
      return svc.resolveReport(req.user!, id, body.data.resolution);
    }),
  );
}
