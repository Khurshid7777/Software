import { expect, test } from "@playwright/test";
import { BUYER, SHOP_OWNER, asBot, catalog, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("follow a shop from its page; it is in the following list", async ({ page }) => {
  const shopItem = (await catalog()).find((i) => i.listing.seller.shop)!;
  await open(page, BUYER, `startapp=seller_${shopItem.listing.seller.id}`);
  await expect(page.getByTestId("followers")).toContainText("Подписчиков: 0");
  await page.getByTestId("follow-toggle").click();
  await expect(page.getByTestId("follow-toggle")).toContainText("Вы подписаны");
  await expect(page.getByTestId("followers")).toContainText("Подписчиков: 1");
  const following = await asBot<Array<{ id: string }>>("GET", "/me/following", BUYER);
  expect(following.map((s) => s.id)).toEqual([shopItem.listing.seller.id]);
});

test("set discount: the shop gives 10 % for two items, the buyer sees it on the listing and at checkout", async ({ page }) => {
  const items = await catalog();
  const shopItem = items.find((i) => i.listing.seller.shop && items.filter((x) => x.listing.seller.id === i.listing.seller.id).length > 1)!;
  await asBot("PUT", "/shops/mine", SHOP_OWNER, { name: shopItem.listing.seller.shop!.name, bundle2Pct: 10, bundle3Pct: 15 });

  await open(page, BUYER, `startapp=listing_${shopItem.listing.id}`);
  await expect(page.getByTestId("bundle-badge")).toContainText("10% за 2 товара, 15% за 3");
  await page.getByTestId("buy-delivery").click();
  await page.getByTestId("checkout-district").selectOption("chilonzor");
  await expect(page.getByTestId("checkout-quote")).toBeVisible();
  await expect(page.getByTestId("bundle-discount")).toHaveCount(0);
  await page.getByTestId("bundle-add").first().click();
  await expect(page.getByTestId("bundle-discount")).toContainText("−10%");
});
