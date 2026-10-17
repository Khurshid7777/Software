import { describe, expect, it } from "vitest";
import {
  canTransition,
  dictionaries,
  inspectionChecklist,
  isLinkOnly,
  normalizeLang,
  operatorNextStatuses,
  parsePrice,
  pickTariff,
  priceVerdict,
  quoteDelivery,
  scoreRisk,
  scrubPii,
  t,
  toUzs,
  costUsd,
  CHECK_CATEGORIES,
  normalizeModelKey,
  sameModel,
  listingPlainText,
  suggestPrice,
  sellerTrust,
  checklistEmpty,
  checklistFields,
  inspectionChecks,
  kitItems,
  repairKinds,
  ConditionChecklistSchema,
  isCargo,
  computeGrade,
  prettyModel,
  type CourierTariff,
} from "../src/index.js";

describe("parsePrice", () => {
  it.each([
    ["3,5 млн", 3_500_000, "UZS"],
    ["3.5 mln so'm", 3_500_000, "UZS"],
    ["3 500 000 сум", 3_500_000, "UZS"],
    ["3.500.000", 3_500_000, "UZS"],
    ["$300", 300, "USD"],
    ["300 у.е.", 300, "USD"],
    ["230$", 230, "USD"],
    ["450k", 450_000, "UZS"],
    ["500 ming", 500_000, "UZS"],
  ])("%s", (input, amount, currency) => {
    expect(parsePrice(input)).toEqual({ amount, currency });
  });

  it("returns null without digits", () => {
    expect(parsePrice("договорная")).toBeNull();
  });

  it("converts USD", () => {
    expect(toUzs(300, "USD", 12800)).toBe(3_840_000);
  });
});

describe("priceVerdict", () => {
  const range = { min: 5_200_000, median: 5_800_000, max: 6_500_000 };

  it("below market", () => {
    const v = priceVerdict(3_480_000, range, "reference");
    expect(v.verdict).toBe("below");
    expect(v.diffPct).toBe(-40);
    expect(v.approximate).toBe(false);
  });

  it("in market", () => {
    expect(priceVerdict(5_900_000, range, "reference").verdict).toBe("market");
  });

  it("above market", () => {
    expect(priceVerdict(7_000_000, range, "reference").verdict).toBe("above");
  });

  it("ai source is approximate", () => {
    expect(priceVerdict(5_900_000, range, "ai").approximate).toBe(true);
  });

  it("unknown without range or price", () => {
    expect(priceVerdict(null, range, "reference").verdict).toBe("unknown");
    expect(priceVerdict(1000, null, "none").verdict).toBe("unknown");
  });
});

describe("scoreRisk", () => {
  it("40% below market + prepayment => high (acceptance criterion)", () => {
    const r = scoreRisk({ priceDiffPct: -40, prepayment: true });
    expect(r.score).toBe(60);
    expect(r.level).toBe("high");
    expect(r.flags.map((f) => f.id)).toEqual(["price_below_market", "prepayment"]);
  });

  it("negative AI adjustment cannot lower the rule-based level", () => {
    const r = scoreRisk({ priceDiffPct: -40, prepayment: true, aiAdjustment: -15 });
    expect(r.level).toBe("high");
  });

  it("AI adjustment is clamped", () => {
    expect(scoreRisk({ aiAdjustment: 99 }).aiAdjustment).toBe(15);
  });

  it("honest listing is low", () => {
    expect(scoreRisk({ priceDiffPct: -5 }).level).toBe("low");
  });

  it("verified shop lowers the score but not below 0", () => {
    const r = scoreRisk({ urgency: true, verifiedShop: true });
    expect(r.score).toBe(0);
  });

  it("medium band", () => {
    expect(scoreRisk({ otherCity: true, urgency: true, accountAgeDays: 1 }).level).toBe(
      "medium",
    );
  });

  it("uses custom rules", () => {
    const r = scoreRisk(
      { urgency: true },
      {
        version: 2,
        priceBelowMarketPct: 30,
        newAccountDays: 3,
        aiAdjustmentMax: 15,
        levels: { medium: 5, high: 50 },
        weights: { urgency: 10 },
      },
    );
    expect(r.level).toBe("medium");
  });
});

describe("i18n", () => {
  it("ru and uz have the same keys", () => {
    expect(Object.keys(dictionaries.uz!).sort()).toEqual(Object.keys(dictionaries.ru!).sort());
  });

  it("interpolates params", () => {
    expect(t("ru", "check.remaining", { n: 3 })).toBe("Осталось проверок сегодня: 3");
  });

  it("normalizes telegram language codes", () => {
    expect(normalizeLang("ru")).toBe("ru");
    expect(normalizeLang("uz")).toBe("uz");
    expect(normalizeLang("en")).toBe("uz");
    expect(normalizeLang(undefined)).toBe("uz");
  });

  it("has a checklist for every category in both languages", () => {
    for (const c of CHECK_CATEGORIES) {
      expect(inspectionChecklist("ru", c).length).toBeGreaterThan(1);
      expect(inspectionChecklist("uz", c).length).toBeGreaterThan(1);
    }
  });
});

describe("input helpers", () => {
  it("detects link-only messages", () => {
    expect(isLinkOnly("https://www.olx.uz/d/obyavlenie/iphone-13-ID123.html")).toBe(true);
    expect(isLinkOnly("посмотри olx.uz/d/abc")).toBe(true);
    expect(isLinkOnly("iPhone 13 128gb за 3,5 млн, состояние идеал https://t.me/x")).toBe(false);
    expect(isLinkOnly("iPhone 13 за 3,5 млн")).toBe(false);
  });

  it("scrubs personal data", () => {
    const s = scrubPii("Звоните +998 90 123-45-67 или @seller_uz, карта 8600 1234 5678 9012");
    expect(s).not.toMatch(/\d{2}[\s-]?\d{2}\b.*45/);
    expect(s).toContain("[phone]");
    expect(s).toContain("[user]");
    expect(s).toContain("[card]");
  });
});

describe("costUsd", () => {
  it("prices haiku", () => {
    expect(costUsd("claude-haiku-5-5", 1_000_000, 1_000_000)).toBeCloseTo(0.6);
  });
});

describe("model matching", () => {
  it("normalizes storage and colours", () => {
    expect(normalizeModelKey("Apple iPhone 13 128 ГБ (Blue)")).toBe("apple iphone 13 128gb");
  });
  it("matches same model, rejects different generation / storage / modifier", () => {
    expect(sameModel("apple iphone 13 128gb", "iphone 13 128 gb midnight")).toBe(true);
    expect(sameModel("apple iphone 13 128gb", "apple iphone 12 128gb")).toBe(false);
    expect(sameModel("apple iphone 13 128gb", "apple iphone 13 256gb")).toBe(false);
    expect(sameModel("apple iphone 13 128gb", "apple iphone 13 pro 128gb")).toBe(false);
  });
});

describe("listing helpers", () => {
  const base = {
    titleRu: "iPhone 13 128 ГБ",
    titleUz: "iPhone 13 128 GB",
    descriptionRu: "Отличное состояние",
    descriptionUz: "A'lo holatda",
    price: 5_800_000,
    condition: "good",
    district: "chilonzor",
  } as unknown as import("../src/index.js").ListingDto;

  it("builds copy-paste text for OLX / Instagram in both languages", () => {
    const ru = listingPlainText(base, "ru");
    expect(ru).toContain("iPhone 13 128 ГБ");
    expect(ru).toContain("5 800 000 UZS");
    expect(ru).toContain("Состояние: Хорошее");
    expect(ru).toContain("Ташкент, Чиланзар");
    const uz = listingPlainText(base, "uz");
    expect(uz).toContain("A'lo holatda");
    expect(uz).toContain("Toshkent, Chilonzor");
    expect(uz).not.toMatch(/https?:/);
  });

  it("suggests quick / market / max prices", () => {
    expect(suggestPrice({ min: 2_600_000, median: 3_000_000, max: 3_400_000 }, "ai")).toEqual({
      quick: 2_700_000,
      market: 3_000_000,
      max: 3_400_000,
      source: "ai",
      approximate: true,
    });
    expect(suggestPrice(null, "none")).toBeNull();
  });
});

// ---------- stage 4: delivery & trust ----------
describe("courier tariffs", () => {
  const tariffs: CourierTariff[] = [
    { id: 1, name: "default", vehicle: "courier", fromDistrict: null, toDistrict: null, price: 30_000, codFeePct: 1, liftPerFloor: 0, active: true },
    { id: 2, name: "to sergeli", vehicle: "courier", fromDistrict: null, toDistrict: "sergeli", price: 40_000, codFeePct: 1, liftPerFloor: 0, active: true },
    { id: 3, name: "chilonzor local", vehicle: "courier", fromDistrict: "chilonzor", toDistrict: "chilonzor", price: 20_000, codFeePct: 1, liftPerFloor: 0, active: true },
    { id: 4, name: "disabled", vehicle: "courier", fromDistrict: null, toDistrict: "yunusobod", price: 1, codFeePct: 0, liftPerFloor: 0, active: false },
    { id: 5, name: "cargo", vehicle: "cargo", fromDistrict: null, toDistrict: null, price: 150_000, codFeePct: 1, liftPerFloor: 15_000, active: true },
  ];

  it("picks the most specific active tariff", () => {
    expect(pickTariff(tariffs, "chilonzor", "chilonzor")!.id).toBe(3);
    expect(pickTariff(tariffs, "chilonzor", "sergeli")!.id).toBe(2);
    expect(pickTariff(tariffs, null, "yunusobod")!.id).toBe(1);
    expect(pickTariff([], null, "yunusobod")).toBeNull();
    // Cargo has its own table: a courier tariff never carries a fridge and vice versa.
    expect(pickTariff(tariffs, "chilonzor", "chilonzor", "cargo")!.id).toBe(5);
    expect(pickTariff(tariffs.slice(0, 4), null, "sergeli", "cargo")).toBeNull();
  });

  it("charges movers per floor above the first only without a lift", () => {
    const cargo = tariffs[4]!;
    const q = (lift: { floor: number; elevator: boolean } | null) => quoteDelivery({ tariff: cargo, itemPrice: 4_000_000, mode: "cod_seller", feePayer: "buyer", lift });
    expect(q({ floor: 5, elevator: false })).toMatchObject({ vehicle: "cargo", deliveryFee: 150_000, liftFee: 60_000, codFee: 40_000, buyerFee: 250_000 });
    expect(q({ floor: 5, elevator: true }).liftFee).toBe(0);
    expect(q({ floor: 1, elevator: false }).liftFee).toBe(0);
    expect(q(null)).toMatchObject({ liftFee: 0, lift: null });
    // A courier quote ignores the floor.
    const courier = quoteDelivery({ tariff: tariffs[0]!, itemPrice: 1_000_000, mode: "cod_seller", feePayer: "buyer", lift: { floor: 9, elevator: false } });
    expect(courier).toMatchObject({ vehicle: "courier", liftFee: 0, lift: null });
    expect(isCargo("large_appliance")).toBe(true);
    expect(isCargo("home_appliance")).toBe(false);
  });

  it("quotes COD fee and splits fees by payer", () => {
    const t = tariffs[0]!;
    const buyer = quoteDelivery({ tariff: t, itemPrice: 5_000_000, mode: "cod_seller", feePayer: "buyer" });
    expect(buyer).toMatchObject({ deliveryFee: 30_000, codFee: 50_000, buyerFee: 80_000, sellerFee: 0, buyerTotal: 5_080_000, sellerReceives: 5_000_000 });
    const seller = quoteDelivery({ tariff: t, itemPrice: 5_000_000, mode: "delivery_only", feePayer: "seller" });
    expect(seller).toMatchObject({ codFee: 0, buyerFee: 0, sellerFee: 30_000, buyerTotal: 5_000_000, sellerReceives: 4_970_000 });
    const split = quoteDelivery({ tariff: t, itemPrice: 1_000_000, mode: "cod_seller", feePayer: "split" });
    expect(split.buyerFee + split.sellerFee).toBe(40_000);
    expect(quoteDelivery({ tariff: null, itemPrice: 1_000_000, mode: "cod_seller", feePayer: "buyer" }).buyerFee).toBe(0);
  });
});

describe("order status machine", () => {
  it("lets each actor make only their own moves", () => {
    expect(canTransition("new", "confirmed", "seller")).toBe(true);
    expect(canTransition("new", "confirmed", "buyer")).toBe(false);
    expect(canTransition("confirmed", "cancelled", "buyer")).toBe(true);
    expect(canTransition("courier_assigned", "cancelled", "buyer")).toBe(false);
    expect(canTransition("picked_up", "delivered", "operator")).toBe(true);
    expect(canTransition("picked_up", "cancelled", "operator")).toBe(false);
    expect(canTransition("delivered", "returned", "operator")).toBe(false);
    expect(operatorNextStatuses("picked_up")).toEqual(["delivered", "returned"]);
    expect(operatorNextStatuses("new")).toEqual(["cancelled"]);
  });
});

describe("seller trust with reviews", () => {
  it("poor reviews override other signals; few reviews do not", () => {
    expect(sellerTrust({ verifiedShop: true, platformSales: 10, accountAgeDays: 400, rating: { avg: 2.3, count: 4 } })).toBe("low");
    expect(sellerTrust({ verifiedShop: true, platformSales: 0, accountAgeDays: 1, rating: { avg: 1, count: 2 } })).toBe("high");
    expect(sellerTrust({ verifiedShop: false, platformSales: 3, accountAgeDays: 1, rating: { avg: 4.8, count: 3 } })).toBe("high");
  });
});

describe("phone detection in listing text", () => {
  it.each(["звоните 90 123 45 67", "+998 90 123-45-67", "+998901234567", "901234567", "90.123.45.67", "(90) 123 45 67"])(
    "finds %s",
    (s) => expect(scrubPii(s)).toContain("[phone]"),
  );
  it.each(["Цена: 125000000 сум", "S/N 123456789", "IMEI 356789012345678", "5 200 000 сум", "Samsung A54 2023", "12 500 000", "батарея 87%"])(
    "leaves %s alone",
    (s) => expect(scrubPii(s)).toBe(s),
  );
});

describe("category-specific condition", () => {
  it("asks each category only what makes sense for it", () => {
    expect(checklistFields("smartphone")).toContain("batteryPct");
    expect(checklistFields("pc_parts")).toEqual(expect.arrayContaining(["mining", "ageYears"]));
    expect(checklistFields("pc_parts")).not.toContain("batteryPct");
    expect(checklistFields("monitor")).toContain("deadPixels");
    expect(checklistFields("home_appliance")).toEqual(["ageYears", "repairs", "kit"]);
    expect(checklistFields("other")).toEqual([]);
    expect(repairKinds("monitor")).toEqual(["none", "other"]);
    expect(kitItems("home_appliance")).not.toContain("charger");
  });

  it("knows when the checklist is still empty", () => {
    expect(checklistEmpty("pc_parts", {})).toBe(true);
    expect(checklistEmpty("pc_parts", { repairs: [] })).toBe(true);
    expect(checklistEmpty("pc_parts", { mining: "never" })).toBe(false);
    // A phone field does not count for a monitor.
    expect(checklistEmpty("monitor", { batteryPct: 90 })).toBe(true);
  });

  it("gives the courier the category's inspection list", () => {
    expect(inspectionChecks("smartphone", true)).toContain("imei_match");
    expect(inspectionChecks("smartphone", false)).not.toContain("imei_match");
    expect(inspectionChecks("pc_parts", true)).toEqual(["matches_description", "powers_on", "load_test", "noise"]);
    expect(inspectionChecks("monitor", true)).toContain("dead_pixels");
    expect(inspectionChecks("home_appliance", true)).not.toContain("biometrics");
    expect(inspectionChecks("laptop", false)).toContain("screen");
  });

  it("validates the new checklist fields", () => {
    expect(ConditionChecklistSchema.parse({ mining: "yes", ageYears: 0, deadPixels: "few" })).toEqual({ mining: "yes", ageYears: 0, deadPixels: "few" });
    expect(ConditionChecklistSchema.safeParse({ mining: "maybe" }).success).toBe(false);
    expect(ConditionChecklistSchema.safeParse({ ageYears: 41 }).success).toBe(false);
  });
});

describe("prettyModel", () => {
  it("writes model keys the way people do", () => {
    expect(prettyModel("apple iphone 13 128gb")).toBe("Apple iPhone 13 128 GB");
    expect(prettyModel("nvidia geforce rtx 3060 12gb")).toBe("Nvidia Geforce RTX 3060 12 GB");
    expect(prettyModel("lg f2j3hs0w 7kg")).toBe("LG F2J3HS0W 7KG");
    expect(prettyModel("samsung galaxy s23 ultra 256gb")).toBe("Samsung Galaxy S23 Ultra 256 GB");
  });
});

describe("item passport: condition grade", () => {
  it("the condition sets the best grade, facts only lower it", () => {
    expect(computeGrade(null, {})).toEqual({ grade: null, reasons: [] });
    expect(computeGrade("new", {}).grade).toBe("A");
    expect(computeGrade("like_new", { batteryPct: 90 }).grade).toBe("A");
    expect(computeGrade("good", { batteryPct: 100 }).grade).toBe("B");
    expect(computeGrade("fair", {}).grade).toBe("C");
    expect(computeGrade("broken", { batteryPct: 100 }).grade).toBe("D");
  });

  it("names the facts that lowered the grade", () => {
    expect(computeGrade("like_new", { batteryPct: 82 })).toEqual({ grade: "B", reasons: ["battery_worn"] });
    expect(computeGrade("like_new", { batteryPct: 75, repairs: ["screen"] })).toEqual({ grade: "C", reasons: ["battery_low"] });
    expect(computeGrade("new", { repairs: ["none"] }).grade).toBe("A");
    expect(computeGrade("new", { repairs: ["screen"] })).toEqual({ grade: "B", reasons: ["repaired"] });
    expect(computeGrade("good", { repairs: ["screen"] })).toEqual({ grade: "B", reasons: [] }); // already B
    expect(computeGrade("like_new", { deadPixels: "many" }).grade).toBe("C");
    expect(computeGrade("like_new", { deadPixels: "few" }).grade).toBe("B");
    expect(computeGrade("like_new", { biometrics: "broken" }).grade).toBe("C");
    expect(computeGrade("new", { mining: "yes" })).toEqual({ grade: "B", reasons: ["mining"] });
  });
});
