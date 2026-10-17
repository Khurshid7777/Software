import { expect, test } from "@playwright/test";
import { BUYER, PRIVATE_SELLER, catalog, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("seller page from a listing: facts, listings, similar items", async ({ page }) => {
  const laptop = (await catalog()).find((i) => i.listing.titleRu.includes("Lenovo"))!;
  await open(page, BUYER, `startapp=listing_${laptop.listing.id}`);
  await expect(page.getByTestId("similar").getByTestId("mini-card").first()).toBeVisible();
  await page.getByTestId("open-seller").click();
  await expect(page.getByTestId("seller-page")).toBeVisible();
  await expect(page.getByTestId("seller-page").getByTestId("mini-card").first()).toBeVisible();
});

test("my listings: tips on how to sell faster", async ({ page }) => {
  await open(page, PRIVATE_SELLER, "screen=my");
  await page.getByTestId("my-more").first().click();
  await page.getByTestId("insights-open").first().click();
  await expect(page.getByTestId("insights")).toBeVisible();
  await expect(page.getByTestId("insights").locator(".tip, .hint-card").first()).toBeVisible();
});

test("first listing: the guide with an example, hidden for good after «Понятно»", async ({ page }) => {
  await open(page, PRIVATE_SELLER, "startapp=screen_sell");
  const guide = page.getByTestId("first-listing-guide");
  await expect(guide).toContainText("Первое объявление");
  await guide.getByTestId("guide-example-toggle").click();
  await expect(page.getByTestId("guide-example")).toContainText("батарея 87%");
  await guide.getByTestId("guide-close").click();
  await expect(page.getByTestId("first-listing-guide")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("sell-analyze")).toBeVisible();
  await expect(page.getByTestId("first-listing-guide")).toHaveCount(0);
});
