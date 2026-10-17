import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Repo } from "../../db/repo.js";
import { channels, shops, users, type User } from "../../db/schema.js";
import { processImage } from "../../storage/images.js";
import type { Storage } from "../../storage/storage.js";

export interface ShopDto {
  id: string;
  name: string;
  marketLocation: string | null;
  hasPhoto: boolean;
  verified: boolean;
  verifiedAt: string | null;
  /** % off for 2 items and for 3+ items in one delivery (0 — no discount). */
  bundle2Pct: number;
  bundle3Pct: number;
}

export class ShopService {
  constructor(
    private repo: Repo,
    private storage: Storage,
  ) {}

  private get db() {
    return this.repo.db;
  }

  private toDto(s: typeof shops.$inferSelect): ShopDto {
    return {
      id: s.id,
      name: s.name,
      marketLocation: s.marketLocation,
      hasPhoto: !!s.photoKey,
      verified: s.verified,
      verifiedAt: s.verifiedAt?.toISOString() ?? null,
      bundle2Pct: s.bundle2Pct,
      bundle3Pct: s.bundle3Pct,
    };
  }

  async mine(user: User) {
    const [s] = await this.db.select().from(shops).where(eq(shops.ownerUserId, user.id));
    return s ? this.toDto(s) : null;
  }

  /** Creating a shop profile switches the account to the "shop" role (no listing limit). */
  async upsert(user: User, data: { name: string; marketLocation?: string | null; bundle2Pct?: number; bundle3Pct?: number }) {
    const bundle = {
      ...(data.bundle2Pct !== undefined ? { bundle2Pct: data.bundle2Pct } : {}),
      ...(data.bundle3Pct !== undefined ? { bundle3Pct: data.bundle3Pct } : {}),
    };
    const [s] = await this.db
      .insert(shops)
      .values({ ownerUserId: user.id, name: data.name, marketLocation: data.marketLocation ?? null, ...bundle })
      .onConflictDoUpdate({
        target: shops.ownerUserId,
        set: { name: data.name, marketLocation: data.marketLocation ?? null, ...bundle },
      })
      .returning();
    if (user.role === "buyer" || user.role === "seller") {
      await this.db.update(users).set({ role: "shop" }).where(eq(users.id, user.id));
    }
    await this.db.update(channels).set({ shopId: s!.id }).where(eq(channels.userId, user.id));
    return this.toDto(s!);
  }

  async setPhoto(user: User, data: Buffer) {
    const shop = await this.mine(user);
    if (!shop) return null;
    const img = await processImage(data);
    const key = `shops/${shop.id}/${randomBytes(6).toString("hex")}.jpg`;
    await this.storage.put(key, img.full, "image/jpeg");
    const [s] = await this.db.update(shops).set({ photoKey: key }).where(eq(shops.id, shop.id)).returning();
    return this.toDto(s!);
  }

  async photo(shopId: string) {
    const [s] = await this.db.select().from(shops).where(eq(shops.id, shopId));
    return s?.photoKey ? this.storage.get(s.photoKey) : null;
  }

  // ---- admin ----
  async list() {
    return (await this.db.select().from(shops).orderBy(desc(shops.createdAt))).map((s) => this.toDto(s));
  }

  async verify(shopId: string, verified: boolean) {
    const [s] = await this.db
      .update(shops)
      .set({ verified, verifiedAt: verified ? new Date() : null })
      .where(eq(shops.id, shopId))
      .returning();
    return s ? this.toDto(s) : null;
  }

  // ---- channels ----
  async channels(user: User) {
    return this.db
      .select({ id: channels.id, telegramChannelId: channels.telegramChannelId, title: channels.title })
      .from(channels)
      .where(eq(channels.userId, user.id));
  }

  /** Called by the bot after Telegram tells it the user made the bot a channel admin. */
  async linkChannel(user: User, telegramChannelId: number, title: string) {
    const shop = await this.mine(user);
    const [c] = await this.db
      .insert(channels)
      .values({ userId: user.id, shopId: shop?.id ?? null, telegramChannelId, title })
      .onConflictDoUpdate({ target: channels.telegramChannelId, set: { userId: user.id, title, shopId: shop?.id ?? null } })
      .returning();
    return c!;
  }

  async unlinkByTelegramId(telegramChannelId: number) {
    const [c] = await this.db.delete(channels).where(eq(channels.telegramChannelId, telegramChannelId)).returning();
    return c ?? null;
  }

  async unlink(user: User, id: number) {
    await this.db.delete(channels).where(and(eq(channels.id, id), eq(channels.userId, user.id)));
  }
}
