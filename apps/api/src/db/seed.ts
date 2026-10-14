import { sql as dsql } from "drizzle-orm";
import { DEFAULT_COMPLAINTS_TO_HIDE, DEFAULT_RISK_RULES } from "@ishonch/shared";
import { loadConfig } from "../config.js";
import { createDb } from "./client.js";
import { categories, courierTariffs, priceReference, settings } from "./schema.js";

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL);

const CATEGORY_SEED = [
  { slug: "electronics", nameRu: "Электроника", nameUz: "Elektronika", parent: null },
  { slug: "smartphone", nameRu: "Смартфоны", nameUz: "Smartfonlar", parent: "electronics" },
  { slug: "laptop", nameRu: "Ноутбуки", nameUz: "Noutbuklar", parent: "electronics" },
  { slug: "tablet", nameRu: "Планшеты", nameUz: "Planshetlar", parent: "electronics" },
  { slug: "headphones", nameRu: "Наушники", nameUz: "Quloqchinlar", parent: "electronics" },
  { slug: "smartwatch", nameRu: "Смарт-часы", nameUz: "Smart soatlar", parent: "electronics" },
  { slug: "console", nameRu: "Игровые приставки", nameUz: "O'yin pristavkalari", parent: "electronics" },
  { slug: "tv", nameRu: "Телевизоры", nameUz: "Televizorlar", parent: "electronics" },
  { slug: "camera", nameRu: "Фототехника", nameUz: "Fototexnika", parent: "electronics" },
] as const;

// Indicative used-market prices in Tashkent, UZS. Starting point only — the admin maintains them.
const M = 1_000_000;
const PRICE_SEED: Array<[string, string, number, number, number]> = [
  ["smartphone", "apple iphone 11 64gb", 2.6 * M, 3.0 * M, 3.5 * M],
  ["smartphone", "apple iphone 11 128gb", 2.9 * M, 3.4 * M, 3.9 * M],
  ["smartphone", "apple iphone 12 128gb", 3.6 * M, 4.2 * M, 4.8 * M],
  ["smartphone", "apple iphone 13 128gb", 5.2 * M, 5.8 * M, 6.5 * M],
  ["smartphone", "apple iphone 13 pro 128gb", 6.5 * M, 7.3 * M, 8.2 * M],
  ["smartphone", "apple iphone 14 128gb", 6.3 * M, 7.0 * M, 7.8 * M],
  ["smartphone", "apple iphone 14 pro 128gb", 8.3 * M, 9.2 * M, 10.2 * M],
  ["smartphone", "apple iphone 15 128gb", 8.0 * M, 8.9 * M, 9.8 * M],
  ["smartphone", "apple iphone 15 pro 128gb", 10.5 * M, 11.5 * M, 12.8 * M],
  ["smartphone", "samsung galaxy a54 128gb", 2.4 * M, 2.8 * M, 3.2 * M],
  ["smartphone", "samsung galaxy a54 256gb", 2.7 * M, 3.1 * M, 3.5 * M],
  ["smartphone", "samsung galaxy s23 256gb", 6.0 * M, 6.8 * M, 7.6 * M],
  ["smartphone", "samsung galaxy s23 ultra 256gb", 9.0 * M, 10.0 * M, 11.2 * M],
  ["smartphone", "xiaomi redmi note 12 128gb", 1.5 * M, 1.8 * M, 2.1 * M],
  ["smartphone", "xiaomi redmi note 13 256gb", 2.1 * M, 2.5 * M, 2.9 * M],
  ["laptop", "apple macbook air m1 256gb", 7.0 * M, 7.8 * M, 8.8 * M],
  ["laptop", "apple macbook air m2 256gb", 9.5 * M, 10.5 * M, 11.8 * M],
  ["tablet", "apple ipad 9 64gb", 2.8 * M, 3.2 * M, 3.7 * M],
  ["headphones", "apple airpods pro 2", 2.2 * M, 2.55 * M, 2.9 * M],
  ["console", "sony playstation 5", 5.5 * M, 6.3 * M, 7.0 * M],
];

const catIds = new Map<string, number>();
for (const c of CATEGORY_SEED) {
  const [row] = await db
    .insert(categories)
    .values({ slug: c.slug, nameRu: c.nameRu, nameUz: c.nameUz, parentId: c.parent ? catIds.get(c.parent) : null })
    .onConflictDoUpdate({ target: categories.slug, set: { nameRu: c.nameRu, nameUz: c.nameUz } })
    .returning({ id: categories.id });
  catIds.set(c.slug, row!.id);
}

for (const [cat, modelKey, min, med, max] of PRICE_SEED) {
  await db
    .insert(priceReference)
    .values({
      categoryId: catIds.get(cat),
      modelKey,
      priceMin: Math.round(min),
      priceMedian: Math.round(med),
      priceMax: Math.round(max),
      source: "seed",
    })
    .onConflictDoNothing({ target: priceReference.modelKey });
}

// Starting courier prices in Tashkent (UZS). The most specific row wins; the admin edits them via /admin/tariffs.
const [{ tariffs }] = (await db.execute(dsql`select count(*)::int as tariffs from courier_tariffs`)) as unknown as [{ tariffs: number }];
if (tariffs === 0) {
  await db.insert(courierTariffs).values([
    { name: "Ташкент (по умолчанию)", price: 30_000, codFeePct: 1 },
    { name: "Окраины: Бектемир", toDistrict: "bektemir", price: 40_000, codFeePct: 1 },
    { name: "Окраины: Сергели", toDistrict: "sergeli", price: 40_000, codFeePct: 1 },
    { name: "Окраины: Янгихаёт", toDistrict: "yangihayot", price: 40_000, codFeePct: 1 },
  ]);
}

const defaults: Record<string, unknown> = {
  checks_per_day: config.CHECKS_PER_DAY,
  usd_rate: config.USD_RATE,
  ai_monthly_limit_usd: config.AI_MONTHLY_LIMIT_USD,
  risk_rules: DEFAULT_RISK_RULES,
  complaints_to_hide: DEFAULT_COMPLAINTS_TO_HIDE,
};
for (const [key, value] of Object.entries(defaults)) {
  await db.insert(settings).values({ key, value }).onConflictDoNothing({ target: settings.key });
}

const [{ count }] = (await db.execute(dsql`select count(*)::int as count from price_reference`)) as unknown as [
  { count: number },
];
console.log(`seed done: ${catIds.size} categories, ${count} price references`);
await sql.end();
