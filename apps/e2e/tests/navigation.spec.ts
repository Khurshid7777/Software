import { expect, test } from "@playwright/test";
import { BUYER, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("storefront: search, categories, fresh listings, tabs", async ({ page }) => {
  await open(page, BUYER);
  await expect(page.getByTestId("mini-card").first()).toBeVisible();
  await expect(page.getByTestId("tab-home")).toHaveAttribute("aria-current", "page");

  await page.getByTestId("home-search").fill("iPhone");
  await page.getByTestId("home-search").press("Enter");
  await expect(page.getByTestId("item-card")).toHaveCount(1);

  await page.goto("about:blank");
  await open(page, BUYER);
  await page.getByTestId("tab-profile").click();
  await expect(page.getByTestId("profile")).toBeVisible();
  await page.getByTestId("tab-orders").click();
  await expect(page.getByTestId("empty")).toBeVisible();
});

test("Back returns to the same catalog scroll position without reloading", async ({ page }) => {
  await open(page, BUYER, "screen=catalog");
  const cards = page.getByTestId("item-card");
  await expect(cards.nth(5)).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 600));
  const before = await page.evaluate(() => window.scrollY);
  await cards.nth(5).locator(".item-main").click();
  await expect(page.getByTestId("listing-view")).toBeVisible();
  await page.getByRole("button", { name: /Назад/ }).click();
  await expect(cards.nth(5)).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
});

test("a listing remembers being viewed; the storefront shows it", async ({ page }) => {
  await open(page, BUYER, "screen=catalog");
  await page.getByTestId("item-card").first().locator(".item-main").click();
  await expect(page.getByTestId("listing-view")).toBeVisible();
  await open(page, BUYER);
  await expect(page.getByTestId("recently-viewed").getByTestId("mini-card")).toHaveCount(1);
});

test("new categories: monitors on the storefront, with their own condition facts", async ({ page }) => {
  await open(page, BUYER);
  await page.locator(".category", { hasText: "Мониторы" }).click();
  const cards = page.getByTestId("item-card");
  await expect(cards).toHaveCount(1);
  await cards.first().locator(".item-main").click();
  const facts = page.getByTestId("checklist-view");
  await expect(facts).toContainText("Битые пиксели: нет");
  await expect(facts).toContainText("В использовании: 1 г.");
});
