import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Repo } from "../db/repo.js";
import type { User } from "../db/schema.js";
import { validateInitData, type TelegramUser } from "./telegram.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    /** "tma" = Mini App (signed initData), "internal" = our bot acting for the user. */
    authVia?: "tma" | "internal";
  }
}

export interface AuthOptions {
  repo: Repo;
  botToken: string;
  internalToken: string;
  maxAgeSec: number;
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Two ways to authenticate:
 *  - Mini App: `Authorization: tma <initData>` (signature checked with the bot token);
 *  - Bot (server-to-server): `Authorization: Internal <token>` + `X-Telegram-User: {"id":..,"language_code":..}`.
 */
export function makeAuth(opts: AuthOptions) {
  async function resolveTelegramUser(req: FastifyRequest): Promise<TelegramUser | null> {
    const res = await resolve(req);
    req.authVia = res?.via;
    return res?.user ?? null;
  }

  async function resolve(req: FastifyRequest): Promise<{ user: TelegramUser; via: "tma" | "internal" } | null> {
    const header = req.headers.authorization ?? "";
    const [scheme, ...rest] = header.split(" ");
    const value = rest.join(" ");
    if (scheme === "tma" && value && opts.botToken) {
      const res = validateInitData(value, opts.botToken, opts.maxAgeSec);
      if (!res.ok) req.log.info({ reason: res.reason }, "initData rejected");
      return res.ok ? { user: res.user, via: "tma" } : null;
    }
    if (scheme === "Internal" && value && safeEqual(value, opts.internalToken)) {
      const raw = req.headers["x-telegram-user"];
      if (typeof raw !== "string") return null;
      try {
        const u = JSON.parse(raw) as TelegramUser;
        return typeof u.id === "number" ? { user: u, via: "internal" } : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async function requireUser(req: FastifyRequest, reply: FastifyReply) {
    const tg = await resolveTelegramUser(req);
    if (!tg) return reply.code(401).send({ error: "unauthorized" });
    const user = await opts.repo.upsertTelegramUser(tg);
    if (user.bannedAt) return reply.code(403).send({ error: "banned" });
    req.user = user;
  }

  function requireRole(...roles: string[]) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      await requireUser(req, reply);
      if (reply.sent) return;
      if (!req.user || !roles.includes(req.user.role)) return reply.code(403).send({ error: "forbidden" });
    };
  }

  /** Only our bot may call these (e.g. it has verified a contact or a channel admin event). */
  async function requireInternal(req: FastifyRequest, reply: FastifyReply) {
    await requireUser(req, reply);
    if (reply.sent) return;
    if (req.authVia !== "internal") return reply.code(403).send({ error: "forbidden" });
  }

  /** Optional auth: sets req.user when credentials are valid, never rejects. */
  async function optionalUser(req: FastifyRequest) {
    const tg = await resolveTelegramUser(req);
    if (!tg) return;
    const user = await opts.repo.upsertTelegramUser(tg);
    if (!user.bannedAt) req.user = user; // a banned user browses as an anonymous visitor
  }

  return { requireUser, requireRole, requireInternal, optionalUser };
}
