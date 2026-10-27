// Seeds the demo catalog (fixtures/assistant.json + the extra stock below) for local development and the demo.
// Photos live in test/demo-photos (generated studio shots, no real brand's product); an item without one gets
// a clean placeholder with its category icon.
//   pnpm --filter @ishonch/api dev:seed-catalog
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, sql as dsql } from "drizzle-orm";
import { PROMPTS_DIR } from "@ishonch/shared/node";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { Repo } from "../src/db/repo.js";
import { evidence, follows, listingPhotos, listings, shops, users } from "../src/db/schema.js";
import { processImage } from "../src/storage/images.js";
import { FsStorage, type Storage } from "../src/storage/storage.js";

/** Real-looking photo of a demo item, or a placeholder: a soft card with the category's line icon. */
const PHOTOS = new URL("./demo-photos/", import.meta.url);
const PLACEHOLDER_ICON: Record<string, string> = {
  laptop: "M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5V15H5zM2.5 18h19M3 15h18l.5 3h-19z",
  console:
    "M6.5 7h11a4.5 4.5 0 0 1 4.4 5.4l-.8 4a2.5 2.5 0 0 1-4.4 1.1L15 15.5H9l-1.7 2a2.5 2.5 0 0 1-4.4-1.1l-.8-4A4.5 4.5 0 0 1 6.5 7zM7.5 11.5h3M9 10v3M15 10.5h.01M17.5 12.5h.01",
  pc_parts: "M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M12 3v4M15 3v4M9 17v4M12 17v4M15 17v4M3 9h4M3 12h4M3 15h4M17 9h4M17 12h4M17 15h4",
};
async function demoPhoto(name: string | undefined, category: string): Promise<Buffer> {
  if (name) return readFileSync(new URL(`${name}.jpg`, PHOTOS));
  const d = PLACEHOLDER_ICON[category] ?? PLACEHOLDER_ICON.laptop!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f3f5fa"/><stop offset="1" stop-color="#e2e7f0"/></linearGradient></defs>
    <rect width="1000" height="1000" fill="url(#g)"/><circle cx="500" cy="500" r="250" fill="#ffffff" opacity="0.75"/>
    <g transform="translate(320 320) scale(15)"><path d="${d}" fill="none" stroke="#0053e2" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  const { default: sharp } = await import("sharp");
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

/** What a seller of these items would write: the brand, the model and the main specs. */
interface DemoFacts {
  photo?: string;
  brand: string;
  model: string;
  specs: Record<string, string>;
}
const FIXTURE_FACTS: Record<string, DemoFacts> = {
  mba_m1: { photo: "laptop_silver", brand: "Apple", model: "MacBook Air M1", specs: { "Процессор": "Apple M1", "Память": "8 ГБ", "Накопитель": "256 ГБ SSD", "Экран": "13,3\" Retina" } },
  lenovo_legion: { brand: "Lenovo", model: "Legion 5", specs: { "Видеокарта": "RTX 3060 6 ГБ", "Память": "16 ГБ", "Накопитель": "512 ГБ SSD", "Экран": "15,6\" 165 Гц" } },
  hp_office: { brand: "HP", model: "250 G8", specs: { "Процессор": "Core i3-1115G4", "Память": "8 ГБ", "Накопитель": "256 ГБ SSD", "Экран": "15,6\" Full HD" } },
  iphone13: { photo: "phone_case", brand: "Apple", model: "iPhone 13", specs: { "Память": "128 ГБ", "Аккумулятор": "86 %", "Цвет": "синий", "Комплект": "коробка, чехол" } },
  redmi_note13: { photo: "phone_blue", brand: "Xiaomi", model: "Redmi Note 13", specs: { "Память": "8/256 ГБ", "Экран": "6,67\" AMOLED", "Камера": "108 Мп", "Аккумулятор": "5000 мА·ч" } },
  airpods_pro2: { photo: "earbuds", brand: "Apple", model: "AirPods Pro 2", specs: { "Разъём": "USB-C", "Шумоподавление": "есть", "Работа": "до 6 ч", "Комплект": "кейс, чек" } },
  ps5: { brand: "Sony", model: "PlayStation 5", specs: { "Версия": "с дисководом", "Накопитель": "825 ГБ", "Геймпады": "2", "Игры": "3 в подарок" } },
};

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
  .onConflictDoUpdate({ target: shops.ownerUserId, set: { verified: true, bundle2Pct: 0, bundle3Pct: 0 } })
  .returning();
await db.delete(follows).where(inArray(follows.sellerUserId, [shopOwner.id, privateSeller.id]));
await db.execute(dsql`update users set notify_off = '{}', away_until = null where telegram_id in (999000001, 999000002, 777000111, 777000222)`);
await db.execute(dsql`delete from stolen_reports where user_id in (select id from users where telegram_id in (999000001, 999000002, 777000111, 777000222))`);
// Saved searches of the demo users (and the alerts they got) start empty: «Куплю» scenarios open them anew.
await db.execute(dsql`delete from saved_searches where user_id in (select id from users where telegram_id in (999000001, 999000002, 777000111, 777000222))`);
await db.execute(dsql`delete from user_blocks where blocker_user_id in (${shopOwner.id}, ${privateSeller.id}) or blocked_user_id in (${shopOwner.id}, ${privateSeller.id})`);
// Daily quotas of the demo buyer (offers): repeated e2e runs on one day must not hit the limit.
// Daily quotas the scenarios use up: repeated runs on one day would hit them.
await db.execute(dsql`delete from events where name in ('offer_made', 'wanted_offer', 'stolen_report', 'data_export')
  and user_id in (select id from users where telegram_id in (999000001, 999000002, 777000111, 777000222))`);
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

function attrs(f: DemoFacts | undefined, modelKey: string) {
  return {
    brand: f?.brand ?? null,
    model: f?.model ?? null,
    modelKey,
    specs: Object.entries(f?.specs ?? {}).map(([name, value]) => ({ name, value })),
  };
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
      attributes: attrs(FIXTURE_FACTS[f.key], f.modelKey),
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
  const img = await processImage(await demoPhoto(FIXTURE_FACTS[f.key]?.photo, f.category));
  const key = `listings/${row!.id}/demo.jpg`;
  await storage.put(key, img.full, "image/jpeg");
  await db.insert(listingPhotos).values({ listingId: row!.id, storageKey: key, phash: img.phash, width: img.width, height: img.height });
  // One phone carries a video passport the AI has read, so the demo shows the verdict on the card and in Versus.
  if (f.key === "iphone13") await demoVideo(row!.id, privateSeller.id);
}

/** A 2-second clip made by ffmpeg (skipped silently where ffmpeg is missing) with a `pass` verdict attached. */
async function demoVideo(listingId: string, userId: string) {
  const dir = mkdtempSync(join(tmpdir(), "ishonch-demo-video-"));
  try {
    const out = join(dir, "clip.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x0053e2:s=320x240:d=2", "-pix_fmt", "yuv420p", "-r", "10", out], { stdio: "ignore" });
    const clip = readFileSync(out);
    const key = `evidence/listings/${listingId}/video-demo.mp4`;
    await storage.put(key, clip, "video/mp4");
    await db.insert(evidence).values({
      kind: "listing_video",
      listingId,
      uploadedBy: userId,
      storageKey: key,
      mime: "video/mp4",
      bytes: clip.length,
      meta: {
        verdict: "pass",
        seen: ["device_on", "identifier", "battery", "account", "body"],
        noteRu: "Телефон включается, на экране виден IMEI и состояние аккумулятора 86%, Apple ID не привязан.",
        noteUz: "Telefon yonadi, ekranda IMEI va batareya holati 86% ko'rinadi, Apple ID bog'lanmagan.",
        seconds: 2,
        at: new Date().toISOString(),
      },
    });
  } catch {
    /* no ffmpeg here: the demo phone simply has no video */
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// The newer categories (not in the assistant fixture, whose cases count its items): a shop's stock, older than
// the fixture items so the storefront order stays the same.
const extra: Array<DemoFacts & {
  category: string;
  titleRu: string;
  titleUz: string;
  descriptionRu: string;
  descriptionUz: string;
  modelKey: string;
  price: number;
  condition: string;
  district: string;
  checklist: Record<string, unknown>;
}> = [
  {
    category: "pc_parts",
    titleRu: "Видеокарта RTX 3060 12 ГБ, без майнинга",
    titleUz: "RTX 3060 12 GB videokarta, mayningsiz",
    descriptionRu: "MSI Ventus 2X, куплена в 2023 для игр. Не майнила, BIOS родной, температуры под нагрузкой до 70°. Коробка и чек есть.",
    descriptionUz: "MSI Ventus 2X, 2023-yilda o'yinlar uchun olingan. Mayningda ishlamagan, BIOS asl, yuklamada 70° gacha. Qutisi va cheki bor.",
    modelKey: "nvidia geforce rtx 3060 12gb",
    photo: "rtx3060", brand: "MSI", model: "GeForce RTX 3060 Ventus 2X", specs: { "Память": "12 ГБ GDDR6", "Разъёмы": "3×DP, HDMI", "Питание": "8-pin", "Майнинг": "не было" },
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
    brand: "AMD", model: "Ryzen 5 5600", specs: { "Ядра / потоки": "6 / 12", "Частота": "до 4,4 ГГц", "Сокет": "AM4", "Кулер": "боксовый" },
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
    photo: "monitor", brand: "Samsung", model: "Odyssey G5", specs: { "Диагональ": "27\" изогнутый", "Разрешение": "2560×1440", "Частота": "144 Гц", "Входы": "DP, HDMI" },
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
    photo: "robot_vacuum", brand: "Xiaomi", model: "Robot Vacuum S10", specs: { "Навигация": "лидар", "Уборка": "сухая и влажная", "Работа": "до 130 мин", "Мощность": "4000 Па" },
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
    photo: "coffee_machine", brand: "De'Longhi", model: "Magnifica S", specs: { "Тип": "автоматическая", "Кофемолка": "встроенная", "Капучинатор": "ручной", "Резервуар": "1,8 л" },
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
    photo: "washer", brand: "LG", model: "F2J3HS0W", specs: { "Загрузка": "7 кг", "Отжим": "1200 об/мин", "Мотор": "инверторный", "Глубина": "45 см" },
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
    photo: "fridge", brand: "Samsung", model: "RB37", specs: { "Высота": "185 см", "Объём": "367 л", "Система": "No Frost", "Класс": "A+" },
    price: 5_100_000,
    condition: "good",
    district: "yunusobod",
    checklist: { ageYears: 5, repairs: ["none"] },
  },
  {
    category: "console",
    photo: "xbox",
    brand: "Microsoft",
    model: "Xbox Series X",
    specs: { "Накопитель": "1 ТБ SSD", "Дисковод": "есть", "Геймпад": "1", "Разрешение": "до 4K 120 Гц" },
    titleRu: "Xbox Series X 1 ТБ с геймпадом",
    titleUz: "Xbox Series X 1 TB, joystik bilan",
    descriptionRu: "Куплена в 2023, играли по выходным. Не перегревается, шума нет. Геймпад без дрифта, коробка сохранилась.",
    descriptionUz: "2023-yilda olingan, dam olish kunlari o'ynalgan. Qizib ketmaydi, shovqin yo'q. Joystik driftsiz, qutisi bor.",
    modelKey: "microsoft xbox series x 1tb",
    price: 5_400_000,
    condition: "like_new",
    district: "chilonzor",
    checklist: {},
  },
  {
    category: "tv",
    photo: "tv",
    brand: "Samsung",
    model: "Crystal UHD 55\"",
    specs: { "Диагональ": "55\"", "Разрешение": "4K UHD", "Smart TV": "Tizen", "Пульт": "оригинальный" },
    titleRu: "Телевизор Samsung 55\" 4K Smart TV",
    titleUz: "Samsung 55\" 4K Smart TV televizor",
    descriptionRu: "Матрица без битых пикселей и засветов, все HDMI работают. Пульт родной, крепление на стену в подарок.",
    descriptionUz: "Matritsada singan piksel va yorug'lik oqishi yo'q, barcha HDMI ishlaydi. Pulti asl, devorga mahkamlagich sovg'a.",
    modelKey: "samsung crystal uhd 55",
    price: 4_300_000,
    condition: "good",
    district: "mirzo_ulugbek",
    checklist: {},
  },
  {
    category: "camera",
    photo: "camera",
    brand: "Olympus",
    model: "OM-D E-M10 IV",
    specs: { "Матрица": "20 Мп, Micro 4/3", "Объектив": "14–150 мм", "Стабилизация": "5-осевая", "Пробег": "≈ 8 000 кадров" },
    titleRu: "Беззеркалка Olympus OM-D E-M10 IV с объективом",
    titleUz: "Olympus OM-D E-M10 IV ko'zgusiz kamera, obyektiv bilan",
    descriptionRu: "Снимал путешествия, пробег около 8 тысяч кадров. Матрица и объектив чистые, две батареи и зарядка в комплекте.",
    descriptionUz: "Sayohatlarda suratga olingan, taxminan 8 ming kadr. Matritsa va obyektiv toza, ikki batareya va zaryadlovchi bilan.",
    modelKey: "olympus om-d e-m10 mark iv",
    price: 6_200_000,
    condition: "good",
    district: "yakkasaroy",
    checklist: {},
  },
  {
    category: "other_electronics",
    photo: "speaker",
    brand: "JBL",
    model: "Flip 6",
    specs: { "Защита": "IP67", "Работа": "до 12 ч", "Связь": "Bluetooth 5.1", "Зарядка": "USB-C" },
    titleRu: "Колонка JBL Flip 6, синяя",
    titleUz: "JBL Flip 6 kolonka, ko'k",
    descriptionRu: "Звук чистый, батарея держит больше 10 часов. Ремешок и кабель в комплекте, царапин нет.",
    descriptionUz: "Ovozi toza, batareya 10 soatdan ko'p ishlaydi. Tasma va kabel bilan, tirnalish yo'q.",
    modelKey: "jbl flip 6",
    price: 950_000,
    condition: "like_new",
    district: "yunusobod",
    checklist: {},
  },
  {
    category: "home_appliance",
    photo: "kettle",
    brand: "Philips",
    model: "Daily Collection",
    specs: { "Объём": "1,7 л", "Мощность": "2200 Вт", "Корпус": "нержавеющая сталь", "Автоотключение": "есть" },
    titleRu: "Электрочайник Philips 1,7 л, сталь",
    titleUz: "Philips elektr choynak 1,7 l, po'lat",
    descriptionRu: "Кипятит быстро, накипи нет — чистили лимонной кислотой. Переезжаем, поэтому продаём.",
    descriptionUz: "Tez qaynatadi, quyqa yo'q — limon kislotasi bilan tozalangan. Ko'chayapmiz, shuning uchun sotamiz.",
    modelKey: "philips hd9350",
    price: 280_000,
    condition: "good",
    district: "mirobod",
    checklist: { ageYears: 2, repairs: ["none"] },
  },
  {
    category: "home_appliance",
    photo: "microwave",
    brand: "Samsung",
    model: "MS23",
    specs: { "Объём": "23 л", "Мощность": "800 Вт", "Управление": "механическое", "Гриль": "нет" },
    titleRu: "Микроволновка Samsung 23 л",
    titleUz: "Samsung mikroto'lqinli pech 23 l",
    descriptionRu: "Греет равномерно, тарелка крутится, дверца закрывается плотно. Внутри чистая.",
    descriptionUz: "Bir tekis isitadi, likopcha aylanadi, eshigi zich yopiladi. Ichi toza.",
    modelKey: "samsung ms23",
    price: 900_000,
    condition: "good",
    district: "olmazor",
    checklist: { ageYears: 3, repairs: ["none"] },
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
      attributes: attrs(f, f.modelKey),
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
  const img = await processImage(await demoPhoto(f.photo, f.category));
  const key = `listings/${row!.id}/demo.jpg`;
  await storage.put(key, img.full, "image/jpeg");
  await db.insert(listingPhotos).values({ listingId: row!.id, storageKey: key, phash: img.phash, width: img.width, height: img.height });
}
console.log(`seeded ${catalog.length + extra.length} demo listings`);
await sql.end();
