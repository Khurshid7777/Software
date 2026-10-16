import { expect, test } from "@playwright/test";
import { BUYER, PRIVATE_SELLER, asBot, catalog, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("offer → the seller accepts in the bot → delivery at the agreed price", async ({ page }) => {
  const iphone = (await catalog()).find((i) => i.listing.titleRu.includes("iPhone"))!;
  await open(page, BUYER, `startapp=listing_${iphone.listing.id}`);
  await expect(page.getByTestId("listing-view")).toBeVisible();

  await page.getByTestId("offer-open").click();
  await page.getByTestId("offer-amount").fill("1000");
  await page.getByTestId("offer-send").click();
  await expect(page.getByTestId("toast")).toContainText("Слишком низкая цена");

  const amount = iphone.listing.price - 400_000;
  await page.getByTestId("offer-amount").fill(String(amount));
  await page.getByTestId("offer-send").click();
  await expect(page.getByTestId("offer-status")).toContainText("ждёт ответа");

  const { offer } = await asBot<{ offer: { id: string } }>("GET", `/listings/${iphone.listing.id}/offers/mine`, BUYER);
  await asBot("POST", `/offers/${offer.id}/accept`, PRIVATE_SELLER);
  await page.reload();
  await expect(page.getByTestId("offer-status")).toContainText("согласен");

  await page.getByTestId("buy-delivery").click();
  await page.getByTestId("checkout-district").selectOption("sergeli");
  await expect(page.getByTestId("offer-applied")).toBeVisible();
  await page.getByTestId("checkout-address").fill("Sergeli 7, uy 12");
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("order-card").first()).toBeVisible();
});

test("leaving a half-filled checkout asks first", async ({ page }) => {
  const item = (await catalog()).find((i) => i.listing.titleRu.includes("PlayStation"))!;
  await open(page, BUYER, `startapp=listing_${item.listing.id}`);
  await page.getByTestId("buy-delivery").click();
  await page.getByTestId("checkout-address").fill("Chilonzor 1");
  page.once("dialog", (d) => void d.dismiss());
  await page.getByRole("button", { name: /Назад/ }).click();
  await expect(page.getByTestId("checkout")).toBeVisible();
});

test("a fridge goes by cargo taxi: floor without a lift adds the movers' fee", async ({ page }) => {
  const fridge = (await catalog()).find((i) => i.listing.titleRu.includes("Холодильник"))!;
  await open(page, BUYER, `startapp=listing_${fridge.listing.id}`);
  await expect(page.getByTestId("listing-cargo")).toBeVisible();
  await page.getByTestId("buy-delivery").click();
  await expect(page.getByTestId("checkout-cargo")).toBeVisible();
  await page.getByTestId("checkout-district").selectOption("chilonzor");
  await expect(page.getByTestId("checkout-quote")).toBeVisible();
  await expect(page.getByTestId("checkout-lift-fee")).toHaveCount(0);

  await page.getByTestId("checkout-floor").selectOption("5");
  await expect(page.getByTestId("checkout-lift-fee")).toContainText("60 000");
  await page.getByTestId("checkout-elevator").check();
  await expect(page.getByTestId("checkout-lift-fee")).toHaveCount(0);
  await page.getByTestId("checkout-elevator").uncheck();
  await expect(page.getByTestId("checkout-lift-fee")).toBeVisible();

  await page.getByTestId("checkout-address").fill("Bunyodkor 12, kv 40");
  await page.getByTestId("checkout-submit").click();
  await expect(page.getByTestId("order-card").first()).toBeVisible();
});
