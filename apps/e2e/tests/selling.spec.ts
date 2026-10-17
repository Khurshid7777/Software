import { expect, test } from "@playwright/test";
import { BUYER, PRIVATE_SELLER, asBot, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("sell faster: offer a price to those who saved the item, then turn on the auto price drop", async ({ page }) => {
  const [l] = await asBot<Array<{ id: string; price: number }>>("GET", "/listings/mine?status=active", PRIVATE_SELLER);
  await asBot("POST", `/favorites/${l!.id}`, BUYER);

  await open(page, PRIVATE_SELLER, "startapp=screen_my");
  const card = page.getByTestId("my-listing").filter({ has: page.getByTestId("likers-open") }).first();
  await card.getByTestId("likers-open").click();
  await expect(card.getByTestId("likers-amount")).toHaveValue(String(Math.floor((l!.price * 0.9) / 1000) * 1000));
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

test("promotion for Telegram Stars: choose days, pay (the bot reports the payment), see the end date", async ({ page }) => {
  await open(page, PRIVATE_SELLER, "startapp=screen_my");
  const card = page.getByTestId("my-listing").filter({ has: page.getByTestId("promote-open") }).first();
  await card.getByTestId("promote-open").click();
  await expect(card.getByTestId("promote-plan-3d")).toContainText("⭐ 50");
  await card.getByTestId("promote-plan-3d").click();
  // Outside Telegram there is no payment sheet: we take the invoice and report the payment as the bot would.
  const [res] = await Promise.all([page.waitForResponse((r) => r.url().includes("/promote")), card.getByTestId("promote-pay").click()]);
  const { promotionId } = (await res.json()) as { promotionId: string };
  await asBot("POST", "/internal/payments/precheck", PRIVATE_SELLER, { payload: `promo:${promotionId}`, currency: "XTR", amount: 50 });
  await asBot("POST", "/internal/payments/paid", PRIVATE_SELLER, { payload: `promo:${promotionId}`, currency: "XTR", amount: 50, chargeId: `e2e-${promotionId}` });
  await page.reload();
  await expect(page.getByTestId("my-listing").filter({ has: page.getByTestId("promoted-until") })).toHaveCount(1);
});
