import { expect, test } from "@playwright/test";
import { BUYER, SHOP_OWNER, catalog, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("new users see how a purchase is protected, once", async ({ page }) => {
  await open(page, BUYER);
  await expect(page.getByTestId("trust-intro")).toContainText("Покупайте спокойно");
  await page.getByTestId("trust-intro-close").click();
  await expect(page.getByTestId("trust-intro")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("home")).toBeVisible();
  await expect(page.getByTestId("trust-intro")).toHaveCount(0);
});

test("item passport: grade on the card, checks with who confirmed them, what a grade means", async ({ page }) => {
  await open(page, BUYER);
  await page.locator(".category", { hasText: "Мониторы" }).click();
  const card = page.getByTestId("item-card").first();
  await expect(card.getByTestId("grade-chip")).toHaveText("A");
  await card.locator(".item-main").click();

  const passport = page.getByTestId("passport");
  await expect(passport).toContainText("Класс A — как новый");
  await expect(page.getByTestId("passport-summary")).toContainText(/Пройдено \d из \d проверок/);
  await page.getByTestId("passport-toggle").click();
  await expect(page.getByTestId("passport-inspection")).toContainText("Курьер ещё не осматривал");
  await expect(page.getByTestId("passport-documents")).toContainText("со слов продавца");
  await page.getByTestId("grade-explain").click();
  await expect(page.getByTestId("grade-legend")).toContainText("на запчасти");
});

test("catalog filter «Класс A–B» keeps only good items", async ({ page }) => {
  await open(page, BUYER, "screen=catalog");
  await expect(page.getByTestId("item-card").first()).toBeVisible();
  const before = await page.getByTestId("item-card").count();
  await page.getByRole("button", { name: /Фильтры/ }).click();
  await page.getByTestId("good-grade").check();
  await page.getByRole("button", { name: /Показать|Применить/ }).click();
  await expect(page.getByTestId("item-card").first()).toBeVisible();
  const grades = await page.getByTestId("item-card").getByTestId("grade-chip").allTextContents();
  expect(grades.length).toBeGreaterThan(0);
  expect(grades.every((g) => g === "A" || g === "B")).toBe(true);
  expect(await page.getByTestId("item-card").count()).toBeLessThanOrEqual(before);
});

test("the seller's video check shows on the listing and in the passport", async ({ page }) => {
  const coffee = (await catalog()).find((i) => i.listing.titleRu.includes("Кофемашина"))!;
  await open(page, SHOP_OWNER, "screen=my");
  const card = page.locator(".card", { hasText: "DeLonghi" }).first();
  await card.getByTestId("my-more").click();
  await card.locator(".chip").filter({ hasText: "✏️" }).first().click();
  await page.getByTestId("video-input").setInputFiles({ name: "check.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(50_000, 1) });
  await expect(page.getByTestId("video-preview")).toBeVisible();

  await open(page, BUYER, `startapp=listing_${coffee.listing.id}`);
  await expect(page.getByTestId("listing-video")).toBeVisible();
  await page.getByTestId("passport-toggle").click();
  await expect(page.getByTestId("passport-video")).toContainText("Есть видео-проверка");
});
