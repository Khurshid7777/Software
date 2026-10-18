import { expect, test } from "@playwright/test";
import { BUYER, PRIVATE_SELLER, asBot, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("sell faster: offer a price to those who saved the item, then turn on the auto price drop", async ({ page }) => {
  const [l] = await asBot<Array<{ id: string; price: number }>>("GET", "/listings/mine?status=active", PRIVATE_SELLER);
  await asBot("POST", `/favorites/${l!.id}`, BUYER);

  await open(page, PRIVATE_SELLER, "startapp=screen_my");
  // The same order as the API list; the less used actions sit behind «⋯ Ещё».
  const card = page.getByTestId("my-listing").first();
  await expect(card.getByTestId("likers-open")).toHaveCount(0);
  await card.getByTestId("my-more").click();
  await card.getByTestId("likers-open").click();
  const offer = String(Math.floor((l!.price * 0.9) / 1000) * 1000).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  await expect(card.getByTestId("likers-amount")).toHaveValue(offer);
  await card.getByTestId("likers-send").click();
  await expect(page.getByText("Предложение отправлено: 1")).toBeVisible();
  await expect(card.getByTestId("likers-last")).toBeVisible();

  await card.getByTestId("autodrop-open").click();
  await card.getByTestId("autodrop-send").click();
  await expect(page.getByText("Автоснижение включено")).toBeVisible();
  await expect(card.getByTestId("autodrop-status")).toContainText("Автоснижение до");
  await card.getByTestId("autodrop-stop").click();
  await expect(card.getByTestId("autodrop-status")).toHaveCount(0);
});

test("sell to shops: verified shops get the listing, and a second request waits a week", async ({ page }) => {
  await open(page, PRIVATE_SELLER, "startapp=screen_my");
  const card = page.getByTestId("my-listing").first();
  await card.getByTestId("my-more").click();
  await card.getByTestId("shops-open").click();
  await expect(card.getByTestId("shops-form")).toContainText("раз в неделю");
  await card.getByTestId("shops-send").click();
  await expect(page.getByText(/Отправили проверенным магазинам: \d+/)).toBeVisible();
  await expect(card.getByTestId("shops-last")).toBeVisible();

  // «⋯ Ещё» stays open after the request.
  await card.getByTestId("shops-open").click();
  await card.getByTestId("shops-send").click();
  await expect(card.getByTestId("sell-faster-error")).toContainText("раз в 7 дней");
});

test("«Куплю»: a buyer shows a saved search to sellers, a seller answers with a matching listing", async ({ page, browser }) => {
  const [l] = await asBot<Array<{ id: string; titleRu: string; price: number }>>("GET", "/listings/mine?status=active", PRIVATE_SELLER);
  const q = l!.titleRu.split(/[ ,]+/).slice(0, 2).join(" ");
  await asBot("POST", "/searches", BUYER, { q, priceMax: l!.price + 500_000 });

  await open(page, BUYER, "startapp=screen_favorites");
  const row = page.getByTestId("saved-search").filter({ hasText: q });
  await row.getByTestId("search-public").click();
  await expect(row.getByTestId("search-public")).toHaveAttribute("aria-pressed", "true");

  const seller = await browser.newPage();
  await open(seller, PRIVATE_SELLER, "startapp=screen_my");
  await seller.getByTestId("open-wanted").click();
  const request = seller.getByTestId("wanted-row").filter({ hasText: q });
  await expect(request).toContainText(l!.titleRu);
  await request.getByTestId("wanted-offer").first().click();
  await expect(seller.getByText("Отправили покупателю")).toBeVisible();
  await expect(request.getByTestId("wanted-offered").first()).toBeVisible();
});
