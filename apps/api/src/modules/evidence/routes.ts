import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { and, eq } from "drizzle-orm";
import { MAX_DISPUTE_PHOTOS, MAX_INSPECTION_PHOTOS, MAX_VIDEO_BYTES, t, type Lang } from "@ishonch/shared";
import type { Repo } from "../../db/repo.js";
import { disputes, listings, orders } from "../../db/schema.js";
import { EvidenceRejected, VIDEO_TYPES, type EvidenceService, type UploadedMedia } from "./service.js";

const IMAGE_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/;
const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const MESSAGES: Record<EvidenceRejected["code"], string> = {
  bad_image: "evidence.err.bad_image",
  bad_video: "evidence.err.bad_video",
  too_many_photos: "evidence.err.too_many_photos",
  too_large: "evidence.err.too_large",
};

/** Files of the accepted kind from a multipart body; a file over the size limit is a 413, not a crash. */
async function readFiles(req: FastifyRequest, accept: RegExp, limits: { fileSize: number; files: number }) {
  const files: UploadedMedia[] = [];
  try {
    for await (const part of req.parts({ limits })) {
      if (part.type !== "file") continue;
      // Wrong type, or more than asked for: drained without reading it into memory.
      if (!accept.test(part.mimetype) || files.length >= limits.files) {
        part.file.resume();
        continue;
      }
      files.push({ data: await part.toBuffer(), mimeType: part.mimetype });
    }
  } catch (err) {
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") throw new EvidenceRejected("too_large", 413);
    throw err;
  }
  return files;
}

/** Evidence (docs/plan.md, stage 15): dispute photos, the courier's inspection photos, the seller's video check. */
export function evidenceRoutes(
  app: FastifyInstance,
  svc: EvidenceService,
  repo: Repo,
  auth: { requireUser: preHandlerHookHandler; requireOperator: preHandlerHookHandler },
) {
  const db = repo.db;

  async function handle<T>(req: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof EvidenceRejected) {
        const lang = (req.user?.language ?? "uz") as Lang;
        return reply.code(err.status).send({ error: err.code, message: t(lang, MESSAGES[err.code] as Parameters<typeof t>[1], { n: MAX_DISPUTE_PHOTOS, mb: MAX_VIDEO_BYTES / 1024 / 1024 }) });
      }
      throw err;
    }
  }

  // Signed URLs: <img> and <video> work without auth headers; ranges are not needed for 20 MB clips.
  app.get<{ Params: { id: string }; Querystring: { s?: string } }>("/media/:id", async (req, reply) => {
    const file = await svc.read(Number(req.params.id), req.query.s ?? "");
    if (!file) return reply.code(404).send({ error: "not_found" });
    return reply.header("content-type", file.mime).header("cache-control", "private, max-age=86400").send(file.data);
  });

  // The buyer's photos for an open dispute.
  app.post<{ Params: { id: string } }>("/orders/:id/dispute/photos", { preHandler: auth.requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      if (!isUuid(req.params.id)) return reply.code(404).send({ error: "not_found" });
      const [d] = await db.select().from(disputes).where(eq(disputes.orderId, req.params.id));
      if (!d || d.buyerUserId !== req.user!.id) return reply.code(404).send({ error: "not_found" });
      if (d.status !== "open") return reply.code(409).send({ error: "bad_state" });
      const files = await readFiles(req, IMAGE_TYPES, { fileSize: 10 * 1024 * 1024, files: MAX_DISPUTE_PHOTOS });
      return { photos: await svc.addPhotos("dispute_photo", { listingId: d.listingId, orderId: d.orderId }, req.user!.id, files, MAX_DISPUTE_PHOTOS) };
    }),
  );

  // The courier's / operator's photos at the pickup inspection (they go into the item passport).
  app.post<{ Params: { id: string } }>("/operator/orders/:id/inspection/photos", { preHandler: auth.requireOperator }, (req, reply) =>
    handle(req, reply, async () => {
      if (!isUuid(req.params.id)) return reply.code(404).send({ error: "not_found" });
      const [o] = await db.select().from(orders).where(eq(orders.id, req.params.id));
      if (!o) return reply.code(404).send({ error: "not_found" });
      if (!["confirmed", "courier_assigned", "picked_up", "delivered", "returned"].includes(o.status)) return reply.code(409).send({ error: "bad_state" });
      const files = await readFiles(req, IMAGE_TYPES, { fileSize: 10 * 1024 * 1024, files: MAX_INSPECTION_PHOTOS });
      return { photos: await svc.addPhotos("inspection_photo", { listingId: o.listingId, orderId: o.id }, req.user!.id, files, MAX_INSPECTION_PHOTOS) };
    }),
  );

  // The seller's short video check (switching on, screen, camera): one per listing, replaced on upload.
  const ownListing = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    if (!isUuid(req.params.id)) return null;
    const [l] = await db
      .select()
      .from(listings)
      .where(and(eq(listings.id, req.params.id), eq(listings.sellerUserId, req.user!.id)));
    return l && ["draft", "active", "pending", "rejected"].includes(l.status) ? l : null;
  };
  app.post<{ Params: { id: string } }>("/listings/:id/video", { preHandler: auth.requireUser }, (req, reply) =>
    handle(req, reply, async () => {
      const l = await ownListing(req);
      if (!l) return reply.code(404).send({ error: "not_found" });
      const [file] = await readFiles(req, VIDEO_TYPES, { fileSize: MAX_VIDEO_BYTES, files: 1 });
      if (!file) throw new EvidenceRejected("bad_video");
      await repo.event(req.user!.id, "listing_video_added", { listingId: l.id, bytes: file.data.length });
      return { video: await svc.setVideo(l.id, req.user!.id, file) };
    }),
  );
  app.delete<{ Params: { id: string } }>("/listings/:id/video", { preHandler: auth.requireUser }, async (req, reply) => {
    const l = await ownListing(req);
    if (!l) return reply.code(404).send({ error: "not_found" });
    await svc.removeVideo(l.id);
    return { video: null };
  });
}
