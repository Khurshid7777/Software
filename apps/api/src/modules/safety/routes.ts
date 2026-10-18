import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { CHAT_REPORT_REASONS, STOLEN_KINDS, t, type Lang } from "@ishonch/shared";
import { SafetyRejected, type SafetyService } from "./service.js";

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export function safetyRoutes(
  app: FastifyInstance,
  svc: SafetyService,
  auth: { requireUser: preHandlerHookHandler; requireInternal: preHandlerHookHandler; requireAdmin: preHandlerHookHandler },
) {
  const MESSAGES: Partial<Record<SafetyRejected["code"], Parameters<typeof t>[1]>> = {
    bad_imei: "stolen.err.bad_imei",
    phone_required: "stolen.err.phone",
    stolen_limit: "stolen.err.limit",
    stolen_exists: "stolen.err.exists",
  };
  async function handle<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SafetyRejected) {
        const key = MESSAGES[err.code];
        const lang = (req.user?.language ?? "ru") as Lang;
        return reply.code(err.status).send({ error: err.code, ...(key ? { message: t(lang, key, { n: 3 }) } : {}) });
      }
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

  // «Украли телефон»: the owner reports an IMEI; matching listings go to a moderator.
  app.get("/me/stolen", { preHandler: auth.requireUser }, (req) => svc.stolenReports(req.user!));
  app.post("/me/stolen", { preHandler: auth.requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const body = z
        .object({ imei: z.string().max(40), kind: z.enum(STOLEN_KINDS), policeReport: z.string().max(100).optional() })
        .safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request" });
      return svc.reportStolen(req.user!, body.data);
    }),
  );
  app.delete<{ Params: { id: string } }>("/me/stolen/:id", { preHandler: auth.requireUser }, (req, reply) =>
    handle(req, reply, () => svc.withdrawStolen(req.user!, Number(req.params.id))),
  );
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
