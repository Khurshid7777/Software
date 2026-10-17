import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { MEETING_FROM_HOUR, MEETING_SPOTS, MEETING_TO_HOUR, MEETING_MAX_DAYS, t, type Lang } from "@ishonch/shared";
import { MeetingRejected, type MeetingService } from "./service.js";

const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

const RequestSchema = z.object({
  spot: z.enum(MEETING_SPOTS).nullable().optional(),
  place: z.string().max(200).nullable().optional(),
  at: z.string().datetime(),
  note: z.string().max(300).nullable().optional(),
});

export function meetingRoutes(app: FastifyInstance, svc: MeetingService, auth: { requireUser: preHandlerHookHandler }) {
  async function handle<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MeetingRejected) {
        const lang = (req.user?.language ?? "uz") as Lang;
        const message = t(lang, `meet.err.${err.code}`, { from: MEETING_FROM_HOUR, to: MEETING_TO_HOUR, days: MEETING_MAX_DAYS });
        return reply.code(err.status).send({ error: err.code, message });
      }
      throw err;
    }
  }

  app.post<{ Params: { id: string } }>("/listings/:id/meetings", { preHandler: auth.requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const body = RequestSchema.safeParse(req.body);
      if (!isUuid(req.params.id) || !body.success) return reply.code(400).send({ error: "bad_request" });
      return svc.request(req.user!, req.params.id, { ...body.data, at: new Date(body.data.at) });
    }),
  );
  app.get("/meetings", { preHandler: auth.requireUser }, (req) => svc.mine(req.user!));
  app.post<{ Params: { id: string; action: string } }>("/meetings/:id/:action", { preHandler: auth.requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const { id, action } = req.params;
      if (!isUuid(id)) return reply.code(404).send({ error: "not_found" });
      if (action === "accept" || action === "decline") return svc.answer(req.user!, id, action === "accept");
      if (action === "cancel") return svc.cancel(req.user!, id);
      if (action === "report") {
        const body = z.object({ bought: z.boolean() }).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "bad_request" });
        return svc.report(req.user!, id, body.data.bought);
      }
      return reply.code(404).send({ error: "not_found" });
    }),
  );
}
