import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { desc, isNotNull } from "drizzle-orm";
import { ADMIN_SETTING_KEYS, AdminSettingsSchema, type AdminSettings } from "@ishonch/shared";
import { startOfMonthUtc, startOfTashkentDay, type Repo } from "../../db/repo.js";
import { users } from "../../db/schema.js";
import type { MetricsService } from "../metrics/service.js";

const PriceRowSchema = z.object({
  modelKey: z.string().min(2),
  priceMin: z.number().positive(),
  priceMedian: z.number().positive(),
  priceMax: z.number().positive(),
  categoryId: z.number().int().nullable().optional(),
});

/** CSV: model_key,price_min,price_median,price_max (header row optional, `;` or `,`). */
export function parsePriceCsv(csv: string) {
  const rows: z.infer<typeof PriceRowSchema>[] = [];
  const errors: string[] = [];
  csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      const cols = line.split(/[;,]/).map((c) => c.trim().replace(/^"|"$/g, ""));
      if (i === 0 && /model/i.test(cols[0] ?? "")) return;
      const parsed = PriceRowSchema.safeParse({
        modelKey: cols[0],
        priceMin: Number(cols[1]),
        priceMedian: Number(cols[2]),
        priceMax: Number(cols[3]),
      });
      if (!parsed.success || parsed.data.priceMin > parsed.data.priceMedian || parsed.data.priceMedian > parsed.data.priceMax) {
        errors.push(`line ${i + 1}: ${line}`);
      } else rows.push(parsed.data);
    });
  return { rows, errors };
}

export function adminRoutes(
  app: FastifyInstance,
  repo: Repo,
  requireAdmin: preHandlerHookHandler,
  extra: { metrics: MetricsService; settingDefaults: AdminSettings; sendDigest: () => Promise<number> },
) {
  const days = (v: unknown) => Math.min(365, Math.max(1, Math.round(Number(v) || 30)));

  app.get<{ Querystring: { days?: string } }>("/admin/metrics", { preHandler: requireAdmin }, (req) =>
    extra.metrics.overview(days(req.query.days)),
  );

  app.get<{ Querystring: { days?: string } }>("/admin/reports/orders.csv", { preHandler: requireAdmin }, async (req, reply) => {
    const n = days(req.query.days);
    const csv = await extra.metrics.ordersCsv(n);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="ishonch-orders-${n}d.csv"`)
      .send("\uFEFF" + csv); // BOM: Excel opens UTF-8 Cyrillic correctly
  });

  app.post("/admin/digest", { preHandler: requireAdmin }, async () => ({ sent: await extra.sendDigest() }));

  app.get<{ Querystring: { limit?: string } }>("/admin/audit", { preHandler: requireAdmin }, (req) =>
    repo.listAudit(Number(req.query.limit) || 200),
  );

  app.get("/admin/settings", { preHandler: requireAdmin }, async () => {
    const out: Record<string, unknown> = {};
    for (const k of ADMIN_SETTING_KEYS) out[k] = await repo.getSetting(k, extra.settingDefaults[k]);
    return out as AdminSettings;
  });

  app.put("/admin/settings", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = AdminSettingsSchema.strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.issues });
    for (const [k, v] of Object.entries(parsed.data)) await repo.setSetting(k, v);
    await repo.audit(req.user!, "settings.update", null, parsed.data);
    const out: Record<string, unknown> = {};
    for (const k of ADMIN_SETTING_KEYS) out[k] = await repo.getSetting(k, extra.settingDefaults[k]);
    return out;
  });

  app.get("/admin/users/banned", { preHandler: requireAdmin }, () =>
    repo.db
      .select({ id: users.id, telegramId: users.telegramId, bannedAt: users.bannedAt, banReason: users.banReason, role: users.role })
      .from(users)
      .where(isNotNull(users.bannedAt))
      .orderBy(desc(users.bannedAt))
      .limit(200),
  );

  app.get("/admin/price-reference", { preHandler: requireAdmin }, () => repo.listPriceReference());

  app.put("/admin/price-reference", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.array(PriceRowSchema).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", details: parsed.error.issues });
    await repo.upsertPriceReference(parsed.data);
    await repo.audit(req.user!, "prices.upsert", null, { count: parsed.data.length });
    return { ok: true, count: parsed.data.length };
  });

  app.delete<{ Params: { id: string } }>("/admin/price-reference/:id", { preHandler: requireAdmin }, async (req) => {
    await repo.deletePriceReference(Number(req.params.id));
    await repo.audit(req.user!, "prices.delete", req.params.id);
    return { ok: true };
  });

  app.post("/admin/price-reference/import", { preHandler: requireAdmin }, async (req) => {
    const { rows, errors } = parsePriceCsv(String(req.body ?? ""));
    await repo.upsertPriceReference(rows.map((r) => ({ ...r, source: "csv" })));
    await repo.audit(req.user!, "prices.import", null, { imported: rows.length, errors: errors.length });
    return { imported: rows.length, errors };
  });

  app.get("/admin/ai-usage", { preHandler: requireAdmin }, async () => {
    const [today, month] = await Promise.all([
      repo.aiSpendSince(startOfTashkentDay()),
      repo.aiSpendSince(startOfMonthUtc()),
    ]);
    const limit = await repo.getSetting("ai_monthly_limit_usd", 50);
    return { todayUsd: today, monthUsd: month, monthlyLimitUsd: limit, overLimit: month >= limit };
  });
}
