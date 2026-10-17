// Seeds the demo catalog (fixtures/assistant.json) with generated photos for local development.
//   pnpm --filter @ishonch/api dev:seed-catalog
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { PROMPTS_DIR } from "@ishonch/shared/node";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { Repo } from "../src/db/repo.js";
import { listingPhotos, listings, shops, users } from "../src/db/schema.js";
import { processImage } from "../src/storage/images.js";
import { FsStorage, type Storage } from "../src/storage/storage.js";
import { testPhoto } from "./helpers.js";

const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL);
const repo = new Repo(db);
const storage: Storage = new FsStorage(process.env.STORAGE_DIR ?? "./data/storage");
const { catalog } = JSON.parse(readFileSync(`${PROMPTS_DIR}__fixtures__/assistant.json`, "utf8"));

const shopOwner = await repo.upsertTelegramUser({ id: 999_000_001, language_code: "uz" });
const privateSeller = await repo.upsertTelegramUser({ id: 999_000_002, language_code: "ru" });
await db.update(users).set({ createdAt: new Date(Date.now() - 200 * 864e5), phone: "+998900000001" }).where(eq(users.id, shopOwner.id));
const [shop] = await db
  .insert(shops)
  .values({ ownerUserId: shopOwner.id, name: "Malika Tech", marketLocation: "Malika, 3-qator, 12", verified: true, verifiedAt: new Date() })
  .onConflictDoUpdate({ target: shops.ownerUserId, set: { verified: true } })
  .returning();
await db.delete(listings).where(eq(listings.sellerUserId, shopOwner.id));
await db.delete(listings).where(eq(listings.sellerUserId, privateSeller.id));

/** A filled-in passport for the demo phones and laptops (the fixture has none). */
function demoChecklist(category: string, condition: string) {
  if (category === "smartphone" || category === "tablet") {
    return { accountUnlocked: true, batteryPct: condition === "new" ? 100 : 88, repairs: ["none"], kit: ["box", "charger"] };
  }
  if (category === "laptop") return { accountUnlocked: true, ageYears: 2, repairs: ["none"], kit: ["charger"] };
  return {};
}

for (const [i, f] of catalog.entries()) {
  const fromShop = ["mba_m1", "redmi_note13", "airpods_pro2"].includes(f.key);
  const [row] = await db
    .insert(listings)
    .values({
      sellerUserId: fromShop ? shopOwner.id : privateSeller.id,
      shopId: fromShop ? shop!.id : null,
      category: f.category,
      titleRu: f.titleRu,
      titleUz: f.titleUz,
      descriptionRu: f.descriptionRu,
      descriptionUz: f.descriptionUz,
      attributes: { brand: null, model: null, modelKey: f.modelKey, specs: [] },
      condition: f.condition,
      price: f.price,
      district: f.district,
      checklist: demoChecklist(f.category, f.condition),
      status: "active",
      publishedAt: new Date(),
      bumpedAt: new Date(Date.now() - i * 60_000),
      expiresAt: new Date(Date.now() + 30 * 864e5),
    })
    .returning();
  const img = await processImage(await testPhoto(i + 2));
  const key = `listings/${row!.id}/demo.jpg`;
  await storage.put(key, img.full, "image/jpeg");
  await db.insert(listingPhotos).values({ listingId: row!.id, storageKey: key, phash: img.phash, width: img.width, height: img.height });
}
// The newer categories (not in the assistant fixture, whose cases count its items): a shop's stock, older than
// the fixture items so the storefront order stays the same.
const extra = [
  {
    category: "pc_parts",
    titleRu: "Видеокарта RTX 3060 12 ГБ, без майнинга",
    titleUz: "RTX 3060 12 GB videokarta, mayningsiz",
    descriptionRu: "MSI Ventus 2X, куплена в 2023 для игр. Не майнила, BIOS родной, температуры под нагрузкой до 70°. Коробка и чек есть.",
    descriptionUz: "MSI Ventus 2X, 2023-yilda o'yinlar uchun olingan. Mayningda ishlamagan, BIOS asl, yuklamada 70° gacha. Qutisi va cheki bor.",
    modelKey: "nvidia geforce rtx 3060 12gb",
    price: 2_900_000,
    condition: "good",
    district: "yunusobod",
    checklist: { mining: "never", ageYears: 2, repairs: ["none"], kit: ["box", "receipt"] },
  },
  {
    category: "pc_parts",
    titleRu: "Процессор Ryzen 5 5600, BOX",
    titleUz: "Ryzen 5 5600 protsessor, BOX",
    descriptionRu: "Ryzen 5 5600 с боксовым кулером, работал в офисном ПК. Разгон не делал, термопасту менял раз в год.",
    descriptionUz: "Ryzen 5 5600, box kuleri bilan, ofis kompyuterida ishlagan. Razgon qilinmagan, termopasta yilda bir marta almashtirilgan.",
    modelKey: "amd ryzen 5 5600",
    price: 1_150_000,
    condition: "good",
    district: "chilonzor",
    checklist: { ageYears: 2, repairs: ["none"], kit: ["box"] },
  },
  {
    category: "monitor",
    titleRu: "Монитор Samsung Odyssey G5 27\" 144 Гц",
    titleUz: "Samsung Odyssey G5 27\" 144 Hz monitor",
    descriptionRu: "Изогнутый 27\", 2K, 144 Гц. Битых пикселей нет, засветов почти нет. Подставка, кабель DP и блок питания в комплекте.",
    descriptionUz: "Egilgan 27\", 2K, 144 Hz. Singan piksellar yo'q, yorug'lik oqishi deyarli yo'q. Tagligi, DP kabeli va quvvat bloki bilan.",
    modelKey: "samsung odyssey g5 27",
    price: 2_750_000,
    condition: "like_new",
    district: "mirzo_ulugbek",
    checklist: { deadPixels: "none", ageYears: 1, repairs: ["none"], kit: ["box"] },
  },
  {
    category: "home_appliance",
    titleRu: "Робот-пылесос Xiaomi S10",
    titleUz: "Xiaomi S10 robot-changyutgich",
    descriptionRu: "Сухая и влажная уборка, лидар, работает с приложением Mi Home. Щётки и фильтр новые, аккумулятор держит около 2 часов.",
    descriptionUz: "Quruq va ho'l tozalash, lidar, Mi Home ilovasi bilan ishlaydi. Cho'tka va filtr yangi, batareya taxminan 2 soat ishlaydi.",
    modelKey: "xiaomi robot vacuum s10",
    price: 1_850_000,
    condition: "good",
    district: "yakkasaroy",
    checklist: { ageYears: 1, repairs: ["none"], kit: ["box", "warranty"] },
  },
  {
    category: "home_appliance",
    titleRu: "Кофемашина DeLonghi Magnifica S",
    titleUz: "DeLonghi Magnifica S kofemashina",
    descriptionRu: "Автоматическая, встроенная кофемолка и капучинатор. Регулярно делали декальцинацию, протечек нет.",
    descriptionUz: "Avtomatik, ichki kofe tegirmoni va kapuchinator bilan. Muntazam dekalsinatsiya qilingan, oqish yo'q.",
    modelKey: "delonghi magnifica s",
    price: 3_100_000,
    condition: "good",
    district: "mirobod",
    checklist: { ageYears: 3, repairs: ["none"], kit: ["receipt"] },
  },
  {
    category: "large_appliance",
    titleRu: "Стиральная машина LG 7 кг, инверторный мотор",
    titleUz: "LG 7 kg kir yuvish mashinasi, invertor motor",
    descriptionRu: "LG F2J3HS0W, 7 кг, 1200 об/мин. Стирает тихо, протечек нет, барабан чистый. Отключим сами, грузчики Ishonch заберут.",
    descriptionUz: "LG F2J3HS0W, 7 kg, 1200 ayl/min. Jim yuvadi, oqish yo'q, baraban toza. O'zimiz uzib beramiz, Ishonch yukchilari olib ketadi.",
    modelKey: "lg f2j3hs0w 7kg",
    price: 2_700_000,
    condition: "good",
    district: "olmazor",
    checklist: { ageYears: 4, repairs: ["none"], kit: ["receipt"] },
  },
  {
    category: "large_appliance",
    titleRu: "Холодильник Samsung RB37, No Frost",
    titleUz: "Samsung RB37 muzlatkich, No Frost",
    descriptionRu: "Двухкамерный, 185 см, No Frost. Морозит отлично, компрессор не менялся. Небольшая царапина на боковой стенке.",
    descriptionUz: "Ikki kamerali, 185 sm, No Frost. Yaxshi muzlatadi, kompressor almashtirilmagan. Yon devorida kichik tirnalish bor.",
    modelKey: "samsung rb37",
    price: 5_100_000,
    condition: "good",
    district: "yunusobod",
    checklist: { ageYears: 5, repairs: ["none"] },
  },
];
for (const [i, f] of extra.entries()) {
  const [row] = await db
    .insert(listings)
    .values({
      sellerUserId: shopOwner.id,
      shopId: shop!.id,
      category: f.category,
      titleRu: f.titleRu,
      titleUz: f.titleUz,
      descriptionRu: f.descriptionRu,
      descriptionUz: f.descriptionUz,
      attributes: { brand: null, model: null, modelKey: f.modelKey, specs: [] },
      condition: f.condition,
      price: f.price,
      district: f.district,
      checklist: f.checklist,
      status: "active",
      publishedAt: new Date(),
      bumpedAt: new Date(Date.now() - (catalog.length + i) * 60_000),
      expiresAt: new Date(Date.now() + 30 * 864e5),
    })
    .returning();
  const img = await processImage(await testPhoto(catalog.length + i + 2));
  const key = `listings/${row!.id}/demo.jpg`;
  await storage.put(key, img.full, "image/jpeg");
  await db.insert(listingPhotos).values({ listingId: row!.id, storageKey: key, phash: img.phash, width: img.width, height: img.height });
}
console.log(`seeded ${catalog.length + extra.length} demo listings`);
await sql.end();
