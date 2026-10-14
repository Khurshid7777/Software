import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { LISTING_STATUSES, t, type Lang, type ListingStatus } from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import type { ShopService } from "../shops/service.js";
import { ListingPatchSchema, ListingRejected, MAX_PHOTOS, type ListingService, type UploadedFile } from "./service.js";

const IMAGE_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/;
const AUDIO_TYPES = /^(audio|video)\/(ogg|webm|mp4|mpeg|mp3|m4a|wav|x-m4a|aac)/;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const I18N_KEY: Record<string, string> = {
  need_photo_or_voice: "sell.need_photo_or_voice",
  too_many_photos: "sell.too_many_photos",
  voice_unavailable: "sell.voice_unavailable",
  ai_unavailable: "check.ai_unavailable",
  phone_required: "sell.phone_required",
  fill_required: "sell.fill_required",
  need_photo: "sell.need_photo",
  limit_reached: "sell.limit_reached",
  not_found: "listing.not_found",
  contact_info: "sell.contact_info",
  duplicate: "sell.duplicate",
};

async function readMultipart(req: FastifyRequest) {
  const photos: UploadedFile[] = [];
  let audio: UploadedFile | undefined;
  const fields: Record<string, string> = {};
  for await (const part of req.parts()) {
    if (part.type === "file") {
      const data = await part.toBuffer();
      if (IMAGE_TYPES.test(part.mimetype)) photos.push({ data, mimeType: part.mimetype });
      else if (AUDIO_TYPES.test(part.mimetype) && !audio) audio = { data, mimeType: part.mimetype };
    } else fields[part.fieldname] = String(part.value);
  }
  return { photos, audio, fields };
}

export function listingRoutes(
  app: FastifyInstance,
  svc: ListingService,
  shopsSvc: ShopService,
  repo: Repo,
  auth: { requireUser: preHandlerHookHandler; requireInternal: preHandlerHookHandler; optionalUser: preHandlerHookHandler; requireAdmin: preHandlerHookHandler },
) {
  const { requireUser } = auth;

  async function handle<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ListingRejected) {
        const lang = (req.user?.language ?? "uz") as Lang;
        const key = I18N_KEY[err.code];
        return reply.code(err.status).send({
          error: err.code,
          params: err.params,
          message: key ? t(lang, key as Parameters<typeof t>[1], err.params) : err.code,
        });
      }
      throw err;
    }
  }

  // ---- drafts ----
  app.post("/listings/drafts", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      if (!req.isMultipart()) {
        const body = (req.body ?? {}) as { text?: string };
        return svc.createDraft(req.user!, { photos: [], text: body.text });
      }
      const { photos, audio, fields } = await readMultipart(req);
      return svc.createDraft(req.user!, { photos, audio, text: fields.text });
    }),
  );

  app.post<{ Params: { id: string }; Body: { answers?: Record<string, string> } }>(
    "/listings/:id/generate",
    { preHandler: requireUser },
    (req, reply) =>
      handle(req, reply, () => {
        const answers = z.record(z.string(), z.string().max(200)).catch({}).parse(req.body?.answers ?? {});
        return svc.generate(req.user!, req.params.id, answers);
      }),
  );

  app.patch<{ Params: { id: string } }>("/listings/:id", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const parsed = ListingPatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.issues });
      return svc.update(req.user!, req.params.id, parsed.data);
    }),
  );

  app.post<{ Params: { id: string } }>("/listings/:id/photos", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const { photos } = await readMultipart(req);
      return svc.addPhotos(req.user!, req.params.id, photos.slice(0, MAX_PHOTOS + 1));
    }),
  );

  app.delete<{ Params: { id: string; photoId: string } }>(
    "/listings/:id/photos/:photoId",
    { preHandler: requireUser },
    (req, reply) => handle(req, reply, () => svc.deletePhoto(req.user!, req.params.id, Number(req.params.photoId))),
  );

  app.delete<{ Params: { id: string } }>("/listings/:id", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      await svc.deleteDraft(req.user!, req.params.id);
      return { ok: true };
    }),
  );

  // ---- publication & management ----
  app.post<{ Params: { id: string }; Body: { channelIds?: number[] } }>(
    "/listings/:id/publish",
    { preHandler: requireUser },
    (req, reply) =>
      handle(req, reply, () => {
        const ids = z.array(z.number().int()).catch([]).parse(req.body?.channelIds ?? []);
        return svc.publish(req.user!, req.params.id, ids);
      }),
  );

  app.post<{ Params: { id: string }; Body: { via?: string } }>("/listings/:id/sold", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => svc.markSold(req.user!, req.params.id, req.body?.via === "platform" ? "platform" : "elsewhere")),
  );

  app.post<{ Params: { id: string } }>("/listings/:id/archive", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => svc.archive(req.user!, req.params.id)),
  );

  app.post<{ Params: { id: string } }>("/listings/:id/bump", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => svc.bump(req.user!, req.params.id)),
  );

  app.post<{ Params: { id: string } }>("/listings/:id/renew", { preHandler: requireUser }, (req, reply) =>
    handle(req, reply, () => svc.renew(req.user!, req.params.id)),
  );

  app.get<{ Querystring: { status?: string } }>("/listings/mine", { preHandler: requireUser }, async (req) => {
    const status = LISTING_STATUSES.includes(req.query.status as ListingStatus) ? (req.query.status as ListingStatus) : undefined;
    return svc.mine(req.user!, status);
  });

  app.get<{ Params: { id: string } }>("/listings/:id", { preHandler: auth.optionalUser }, (req, reply) =>
    handle(req, reply, () => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new ListingRejected("not_found", 404);
      return svc.view(req.params.id, req.user ?? null);
    }),
  );

  // Signed URLs so that <img> tags work without auth headers.
  app.get<{ Params: { id: string }; Querystring: { s?: string } }>("/photos/:id", async (req, reply) => {
    const data = await svc.readPhoto(Number(req.params.id), req.query.s ?? "");
    if (!data) return reply.code(404).send({ error: "not_found" });
    return reply.header("content-type", "image/jpeg").header("cache-control", "public, max-age=31536000, immutable").send(data);
  });

  // ---- shops ----
  app.get("/shops/mine", { preHandler: requireUser }, async (req) => ({
    shop: await shopsSvc.mine(req.user!),
    channels: await shopsSvc.channels(req.user!),
  }));

  app.put("/shops/mine", { preHandler: requireUser }, async (req, reply) => {
    const parsed = z
      .object({ name: z.string().trim().min(2).max(80), marketLocation: z.string().trim().max(200).nullable().optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
    return shopsSvc.upsert(req.user!, parsed.data);
  });

  app.post("/shops/mine/photo", { preHandler: requireUser }, async (req, reply) => {
    const { photos } = await readMultipart(req);
    if (!photos[0]) return reply.code(400).send({ error: "bad_request" });
    const shop = await shopsSvc.setPhoto(req.user!, photos[0].data);
    return shop ?? reply.code(404).send({ error: "not_found" });
  });

  app.get<{ Params: { id: string } }>("/shops/:id/photo", async (req, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    const data = await shopsSvc.photo(req.params.id);
    if (!data) return reply.code(404).send({ error: "not_found" });
    return reply.header("content-type", "image/jpeg").send(data);
  });

  app.delete<{ Params: { id: string } }>("/channels/:id", { preHandler: requireUser }, async (req) => {
    await shopsSvc.unlink(req.user!, Number(req.params.id));
    return { ok: true };
  });

  // ---- bot-only (internal) ----
  app.post<{ Body: { telegramChannelId: number; title: string } }>(
    "/internal/channels",
    { preHandler: auth.requireInternal },
    async (req, reply) => {
      const parsed = z.object({ telegramChannelId: z.number().int(), title: z.string().min(1).max(255) }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "bad_request" });
      return shopsSvc.linkChannel(req.user!, parsed.data.telegramChannelId, parsed.data.title);
    },
  );

  app.delete<{ Params: { tgId: string } }>("/internal/channels/:tgId", { preHandler: auth.requireInternal }, async (req) => {
    const c = await shopsSvc.unlinkByTelegramId(Number(req.params.tgId));
    return { ok: true, title: c?.title ?? null };
  });

  app.post<{ Body: { phone: string } }>("/internal/phone", { preHandler: auth.requireInternal }, async (req, reply) => {
    const phone = String(req.body?.phone ?? "").replace(/[^\d+]/g, "");
    if (phone.replace(/\D/g, "").length < 9) return reply.code(400).send({ error: "bad_phone" });
    await repo.setPhone(req.user!.id, phone.startsWith("+") ? phone : `+${phone}`);
    return { ok: true };
  });

  // ---- admin ----
  app.get("/admin/shops", { preHandler: auth.requireAdmin }, () => shopsSvc.list());
  app.post<{ Params: { id: string }; Body: { verified?: boolean } }>(
    "/admin/shops/:id/verify",
    { preHandler: auth.requireAdmin },
    async (req, reply) => (await shopsSvc.verify(req.params.id, req.body?.verified !== false)) ?? reply.code(404).send({ error: "not_found" }),
  );
}
