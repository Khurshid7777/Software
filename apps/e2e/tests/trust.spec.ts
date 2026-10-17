import { expect, test } from "@playwright/test";
import { BUYER, OPERATOR, SHOP_OWNER, asBot, catalog, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("«Сколько стоит?»: model + condition → market price, then straight to selling", async ({ page }) => {
  await open(page, BUYER);
  await page.getByTestId("open-valuation").click();
  await page.getByTestId("valuation-model").fill("iPhone 13 128 ГБ");
  await page.getByTestId("valuation-submit").click();
  const result = page.getByTestId("valuation-result");
  await expect(result).toContainText("Apple iPhone 13 128 GB");
  await expect(result).toContainText("5 800 000"); // the seeded reference median, condition "good"

  await page.getByTestId("valuation-condition-fair").click();
  await expect(result).toContainText("4 930 000"); // 85 %
  await page.getByTestId("valuation-sell").click();
  await expect(page.getByTestId("sell-analyze")).toBeVisible();
});

test("trade-in: the seller allows exchange, the buyer offers their phone plus a top-up", async ({ page }) => {
  const redmi = (await catalog()).find((i) => i.listing.titleRu.includes("Redmi"))!;
  await asBot("PATCH", `/listings/${redmi.listing.id}`, SHOP_OWNER, { acceptsTrade: true });

  await open(page, BUYER, `startapp=listing_${redmi.listing.id}`);
  await expect(page.getByTestId("trade-badge")).toBeVisible();
  await page.getByTestId("trade-open").click();
  await page.getByTestId("trade-title").fill("iPhone 11 64 ГБ");
  await page.getByTestId("trade-dir-me").click();
  await page.getByTestId("trade-amount").fill("300000");
  await page.getByTestId("trade-send").click();
  await expect(page.getByTestId("offer-status")).toContainText("ждёт ответа продавца");
  await expect(page.getByTestId("trade-open")).toHaveCount(0);
});

test("guarantee: a delivered order can be disputed for 3 days", async ({ page }) => {
  const coffee = (await catalog()).find((i) => i.listing.titleRu.includes("Кофемашина"))!;
  const order = await asBot<{ id: string }>("POST", "/orders", BUYER, {
    listingId: coffee.listing.id,
    mode: "cod_seller",
    district: "mirobod",
    address: "Mirobod 5, kv 12",
  });
  await asBot("POST", `/orders/${order.id}/confirm`, SHOP_OWNER);
  for (const status of ["courier_assigned", "picked_up", "delivered"]) {
    await asBot("POST", `/operator/orders/${order.id}/status`, OPERATOR, { status });
  }

  await open(page, BUYER, `startapp=order_${order.id}`);
  const card = page.locator(`#order-${order.id}`);
  await expect(card.getByTestId("guarantee-badge")).toContainText("Защита покупателя");
  await card.getByTestId("dispute-open").click();
  await card.getByTestId("dispute-reason-not_working").click();
  await card.getByTestId("dispute-text").fill("Через день перестала молоть кофе, гудит и не включается");
  await card.getByTestId("dispute-send").click();
  await expect(card.getByTestId("dispute-status")).toContainText("Открыт спор: не работает");
  await expect(card.getByTestId("dispute-open")).toHaveCount(0);

  // A photo of the problem goes with the dispute (stage 15).
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC",
    "base64",
  );
  await card.getByTestId("dispute-photo-input").setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: png });
  await expect(card.getByTestId("dispute-photos").locator("img")).toHaveCount(1);
});
