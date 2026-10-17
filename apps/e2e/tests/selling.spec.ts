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
