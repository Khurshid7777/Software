import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import {
  AssistantMessageSchema,
  CATALOG_SORTS,
  CatalogFiltersSchema,
  CONDITIONS,
  LANGS,
  t,
  type CatalogSort,
  type Lang,
} from "@ishonch/shared";
import { AssistantRejected, type AssistantService } from "./assistant.js";
import { CatalogRejected, type CatalogService } from "./service.js";
import { ListingRejected } from "../listings/service.js";

const MESSAGES: Record<string, string> = {
  contact_limit: "listing.contact_limit",
  message_limit: "listing.message_limit",
  not_found: "listing.not_found",
  own_listing: "listing.own",
  seller_unreachable: "bot.reply_failed",
  limit_reached: "assistant.limit",
  ai_unavailable: "check.ai_unavailable",
};

/** Query string → filters (conditions come as a comma-separated list). */
export function parseFilters(query: Record<string, unknown>) {
  const conditions =
    typeof query.conditions === "string" && query.conditions
      ? query.conditions.split(",").filter((c): c is (typeof CONDITIONS)[number] => (CONDITIONS as readonly string[]).includes(c))
      : undefined;
  const parsed = CatalogFiltersSchema.safeParse({
    ...query,
    conditions,
    verifiedOnly: query.verifiedOnly === "true" || query.verifiedOnly === "1" || query.verifiedOnly === true ? true : undefined,
    q: typeof query.q === "string" && query.q.trim() ? query.q : undefined,
  });
  return parsed.success ? parsed.data : null;
}

export function catalogRoutes(
  app: FastifyInstance,
  catalog: CatalogService,
  assistant: AssistantService,
  auth: { requireUser: preHandlerHookHandler; requireInternal: preHandlerHookHandler; optionalUser: preHandlerHookHandler },
) {
  const { requireUser } = auth;

  async function handle<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CatalogRejected || err instanceof AssistantRejected) {
        const lang = (req.user?.language ?? "uz") as Lang;
        const key = MESSAGES[err.code];
        return reply
          .code(err.status)
          .send({ error: err.code, message: key ? t(lang, key as Parameters<typeof t>[1]) : err.code });
      }
      throw err;
    }
  }

  app.get<{ Querystring: Record<string, string> }>("/catalog", { preHandler: auth.optionalUser }, async (req, reply) => {
    const filters = parseFilters(req.query);
    if (!filters) return reply.code(400).send({ error: "bad_request" });
    const sort = (CATALOG_SORTS as readonly string[]).includes(req.query.sort ?? "") ? (req.query.sort as CatalogSort) : "relevance";
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const page = await catalog.search(filters, sort, offset, req.user ?? null);
    // First page only: one event per search, with the result count (zero results feed the spelling dictionary).
    if (req.user && offset === 0) {
      await catalog.logSearch(req.user.id, filters, page.items.length);
    }
    return page;
  });

  app.get<{ Params: { id: string } }>("/catalog/:id", { preHandler: auth.optionalUser }, async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    try {
      return await catalog.viewItem(req.params.id, req.user ?? null);
    } catch (err) {
      if (err instanceof ListingRejected) {
        return reply.code(404).send({ error: "not_found", message: t((req.user?.language ?? "uz") as Lang, "listing.not_found") });
      }
      throw err;
    }
  });

  // ---- favorites ----
  app.get("/favorites", { preHandler: requireUser }, (req) => catalog.favorites(req.user!));
  app.post<{ Params: { id: string } }>("/favorites/:id", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => catalog.setFavorite(req.user!, req.params.id, true)),
  );
  app.delete<{ Params: { id: string } }>("/favorites/:id", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => catalog.setFavorite(req.user!, req.params.id, false)),
  );

  // ---- saved searches ----
  app.get("/searches", { preHandler: requireUser }, (req) => catalog.listSearches(req.user!));
  app.post("/searches", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const parsed = CatalogFiltersSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      return catalog.saveSearch(req.user!, parsed.data);
    }),
  );
  app.delete<{ Params: { id: string } }>("/searches/:id", { preHandler: requireUser }, async (req) => {
    await catalog.deleteSearch(req.user!, Number(req.params.id));
    return { ok: true };
  });

  // ---- masked chat ----
  app.post<{ Params: { id: string }; Body: { text?: string } }>("/listings/:id/contact", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => catalog.contactSeller(req.user!, req.params.id, String(req.body?.text ?? ""))),
  );
  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/internal/conversations/:id/messages",
    { preHandler: auth.requireInternal },
    (req, reply) =>
      handle(req, reply, async () => {
        const text = String(req.body?.text ?? "").trim();
        if (!text) return reply.code(400).send({ error: "bad_request" });
        await catalog.relay(req.params.id, req.user!, text);
        return { ok: true };
      }),
  );

  // ---- AI assistant ----
  app.post<{ Body: { messages?: unknown; lang?: string } }>("/assistant", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const parsed = z.array(AssistantMessageSchema).min(1).max(20).safeParse(req.body?.messages);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      const lang = (LANGS as readonly string[]).includes(req.body?.lang ?? "") ? (req.body!.lang as Lang) : (req.user!.language as Lang);
      return assistant.ask(req.user!, lang, parsed.data);
    }),
  );
  app.post<{ Body: { ids?: unknown; needs?: string; lang?: string } }>("/assistant/compare", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const ids = z.array(z.string().uuid()).min(2).max(3).safeParse(req.body?.ids);
      if (!ids.success) return reply.code(400).send({ error: "bad_request" });
      const lang = (LANGS as readonly string[]).includes(req.body?.lang ?? "") ? (req.body!.lang as Lang) : (req.user!.language as Lang);
      return assistant.compare(req.user!, lang, ids.data, req.body?.needs?.slice(0, 300));
    }),
  );
}
