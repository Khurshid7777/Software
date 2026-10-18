import { expect, test } from "@playwright/test";
import { BUYER, PRIVATE_SELLER, asBot, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("a seller blocks a buyer from the chat, then lifts the block in the profile", async ({ page }) => {
  const [l] = await asBot<Array<{ id: string }>>("GET", "/listings/mine?status=active", PRIVATE_SELLER);
  const { conversationId } = await asBot<{ conversationId: string }>("POST", `/listings/${l!.id}/contact`, BUYER, { text: "Здравствуйте! Ещё продаёте?" });
  await asBot("POST", `/internal/conversations/${conversationId}/block`, PRIVATE_SELLER);
  await expect(asBot("POST", `/listings/${l!.id}/contact`, BUYER, { text: "Ответьте" })).rejects.toThrow(/403/);

  await open(page, PRIVATE_SELLER, "startapp=screen_profile");
  await page.getByTestId("open-blocks").click();
  const row = page.getByTestId("block-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Покупатель по «");
  await row.getByTestId("unblock").click();
  await expect(page.getByTestId("block-row")).toHaveCount(0);
  await asBot("POST", `/listings/${l!.id}/contact`, BUYER, { text: "Снова здравствуйте" });
});

test("notification settings: a type switched off stays off after reopening", async ({ page }) => {
  await open(page, BUYER, "startapp=screen_profile");
  await page.getByTestId("open-notifications").click();
  const priceDrop = page.getByTestId("notify-price_drop");
  await expect(priceDrop).toBeChecked();
  await priceDrop.uncheck();
  await expect(priceDrop).not.toBeChecked();
  await open(page, BUYER, "startapp=screen_notifications");
  await expect(page.getByTestId("notify-price_drop")).not.toBeChecked();
  await expect(page.getByTestId("notify-follow")).toBeChecked();
  const me = await asBot<{ notifyOff: string[] }>("GET", "/me", BUYER);
  expect(me.notifyOff).toEqual(["price_drop"]);
});

test("stolen phone: the owner reports an IMEI, sees it by its last digits, then marks it found", async ({ page }) => {
  await open(page, BUYER);
  await page.getByTestId("tab-profile").click();
  await page.getByTestId("open-stolen").click();
  await page.getByTestId("stolen-imei").fill("35 7000 1122 3344 7");
  await expect(page.getByTestId("stolen-send")).toBeDisabled(); // wrong check digit
  await page.getByTestId("stolen-imei").fill("356100112233448");
  await page.getByTestId("stolen-police").fill("123/45");
  await page.getByTestId("stolen-send").click();
  await expect(page.getByText("Сообщение принято")).toBeVisible();
  const row = page.getByTestId("stolen-row").filter({ hasText: "…3448" });
  await expect(row).toBeVisible();
  page.once("dialog", (d) => void d.accept());
  await row.getByTestId("stolen-found").click();
  await expect(row).toHaveCount(0);
});
