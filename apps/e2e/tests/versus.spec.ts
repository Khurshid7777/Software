import { expect, test } from "@playwright/test";
import { BUYER, PRIVATE_SELLER, catalog, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("Versus: collect listings from the catalog, see them side by side with the best value highlighted", async ({ page }) => {
  await open(page, BUYER, "screen=catalog");
  await page.evaluate(() => localStorage.removeItem("ishonch.compare"));
  await page.reload();
  const cards = page.getByTestId("item-card");
  await expect(cards.nth(2)).toBeVisible();
  await expect(page.getByTestId("compare-tray")).toHaveCount(0);

  await cards.nth(0).getByTestId("item-compare").click();
  await expect(page.getByTestId("compare-tray")).toContainText("Сравнить (1)");
  await cards.nth(1).getByTestId("item-compare").click();
  await cards.nth(2).getByTestId("item-compare").click();
  await expect(page.getByTestId("compare-tray")).toContainText("Сравнить (3)");
  await expect(cards.nth(0).getByTestId("item-compare")).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("compare-tray-open").click();
  await expect(page.getByTestId("compare")).toBeVisible();
  await expect(page.getByTestId("compare-row-price").locator("td")).toHaveCount(3);
  // The cheapest column is marked best; a row where all values match has no highlight.
  const prices = await page.getByTestId("compare-row-price").locator("td").allTextContents();
  const nums = prices.map((p) => Number(p.replace(/\D/g, "")));
  const best = await page.getByTestId("compare-row-price").locator("td.best").allTextContents();
  expect(best.length).toBeGreaterThanOrEqual(1);
  expect(Number(best[0]!.replace(/\D/g, ""))).toBe(Math.min(...nums));
  await expect(page.getByTestId("compare-row-passport").locator("td").first()).toContainText(/\d+ из \d+/);

  // Removing a column and the AI opinion (deterministic from fixtures on the mock server).
  await page.getByTestId("compare-remove").first().click();
  await expect(page.getByTestId("compare-row-price").locator("td")).toHaveCount(2);
  await page.getByTestId("compare-ask-ai").click();
  await expect(page.getByTestId("compare-ai")).toBeVisible();
  await expect(page.getByTestId("compare-ai-row").locator("td")).toHaveCount(2);

  await page.getByTestId("compare-clear").click();
  await expect(page.getByTestId("empty")).toContainText("Пока нечего сравнивать");
});

test("Versus from a listing: «Сравнить» on the card and «Сравнить с похожими»", async ({ page }) => {
  const phone = (await catalog()).find((i) => i.listing.titleRu.includes("Lenovo"))!;
  await open(page, BUYER, `startapp=listing_${phone.listing.id}`);
  await page.evaluate(() => localStorage.removeItem("ishonch.compare"));
  await expect(page.getByTestId("listing-view")).toBeVisible();
  await page.getByTestId("listing-compare").click();
  await expect(page.getByTestId("listing-compare")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("similar").getByTestId("mini-card").first()).toBeVisible();
  await page.getByTestId("compare-similar").click();
  await expect(page.getByTestId("compare")).toBeVisible();
  const columns = await page.getByTestId("compare-row-price").locator("td").count();
  expect(columns).toBeGreaterThanOrEqual(2);
  expect(columns).toBeLessThanOrEqual(4);
});

test("«Как проходит проверка»: from the hero, the catalog strip, the listing and the profile", async ({ page }) => {
  await open(page, BUYER);
  await page.evaluate(() => localStorage.removeItem("ishonch.trust_intro_seen"));
  await page.reload();
  await expect(page.getByTestId("trust-intro")).toContainText("10 минут осмотра");
  await page.getByTestId("open-how").click();
  await expect(page.getByTestId("how")).toContainText("Как проходит проверка");
  await expect(page.getByTestId("how")).toContainText("у вас 10 минут");
  await expect(page.getByTestId("how")).toContainText("Не подошло — не платите");
  await expect(page.getByTestId("how-checklist")).toContainText("*#06#");
  await page.getByTestId("how-checklist").getByRole("button", { name: "Ноутбуки" }).click();
  await expect(page.getByTestId("how-checklist")).toContainText("BIOS");
  await page.getByTestId("how-catalog").click();
  await expect(page.getByTestId("item-card").first()).toBeVisible();

  // The same promise sits above the catalog, on every listing and in the profile menu.
  await expect(page.getByTestId("promise")).toContainText("10 минут на проверку при получении");
  await page.getByTestId("item-card").first().locator(".item-main").click();
  await expect(page.getByTestId("listing-view").getByTestId("promise")).toContainText("не платите");
  await page.getByTestId("listing-view").getByTestId("promise").click();
  // Screens below the top stay mounted (hidden): the earlier «how» is still in the stack.
  await expect(page.getByTestId("how").last()).toBeVisible();
  await expect(page.getByTestId("how").last()).toContainText("Смартфоны");

  await open(page, BUYER, "screen=profile");
  await page.getByTestId("open-how").click();
  await expect(page.getByTestId("how")).toBeVisible();
});

test("video passport in the seller's editor: the script, «required» for phones, AI verdict on the listing", async ({ page }) => {
  await open(page, PRIVATE_SELLER, "screen=my");
  const card = page.locator(".card", { hasText: "iPhone" }).first();
  await card.getByTestId("my-more").click();
  await card.locator(".chip").filter({ hasText: "✏️" }).first().click();
  const block = page.getByTestId("video-check");
  await expect(block).toContainText("Видео-паспорт");
  await expect(block.getByTestId("video-required")).toHaveText("Обязательно для публикации");
  await expect(block).toContainText("*#06#");
  await block.getByTestId("video-input").setInputFiles({ name: "check.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(50_000, 1) });
  await expect(block.getByTestId("video-preview")).toBeVisible();
  // The dev mock has no real video: the AI did not look.
  await expect(block.getByTestId("video-verdict")).toContainText("AI его не проверял");
});
