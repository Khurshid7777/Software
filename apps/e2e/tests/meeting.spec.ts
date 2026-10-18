import { expect, test } from "@playwright/test";
import { BUYER, PRIVATE_SELLER, asBot, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("meet in person: the buyer proposes a safe place and time, the seller agrees, the buyer sees what to check", async ({ page }) => {
  const [l] = await asBot<Array<{ id: string }>>("GET", "/listings/mine?status=active", PRIVATE_SELLER);
  await open(page, BUYER, `startapp=listing_${l!.id}`);
  await page.getByTestId("meet-open").click();
  await page.getByTestId("meet-spot-compass").click();
  await page.getByTestId("meet-day-1").click();
  await page.getByTestId("meet-slot").nth(3).click(); // tomorrow 12:00
  await expect(page.getByTestId("meet-safety")).toContainText("Проверьте товар до оплаты");
  await page.getByTestId("meet-send").click();
  await expect(page.getByTestId("meet-sent")).toBeVisible();

  // The seller answers in the Mini App (the bot has the same buttons).
  await open(page, PRIVATE_SELLER, "startapp=screen_orders");
  await page.getByRole("tab").nth(1).click();
  const card = page.getByTestId("meeting-card").first();
  await expect(card).toContainText("Compass");
  await expect(card).toContainText("12:00");
  await card.getByTestId("meeting-accept").click();
  await expect(card.getByTestId("meeting-status")).toContainText("Договорились");

  await open(page, BUYER, "startapp=screen_orders");
  const mine = page.getByTestId("meeting-card").first();
  await expect(mine.getByTestId("meeting-status")).toContainText("Договорились");
  await expect(mine.getByTestId("meet-checklist")).toBeVisible();
});
