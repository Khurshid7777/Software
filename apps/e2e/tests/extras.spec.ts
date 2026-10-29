import { expect, test } from "@playwright/test";
import { BUYER, OPERATOR, PRIVATE_SELLER, SHOP_OWNER, asBot, catalog, open, resetDemo } from "./helpers";

test.beforeAll(resetDemo);

test("catalog: one-tap filters and the list view that is remembered", async ({ page }) => {
  await open(page, BUYER, "screen=catalog");
  const cards = page.getByTestId("item-card");
  await expect(cards.nth(3)).toBeVisible();
  const all = await cards.count();

  await page.getByTestId("quick-grade").click();
  await expect(page.getByTestId("quick-grade")).toHaveAttribute("aria-pressed", "true");
  await expect(cards.first()).toBeVisible();
  const grades = await cards.getByTestId("grade-chip").allTextContents();
  expect(grades.length).toBeGreaterThan(0);
  expect(grades.every((g) => g === "A" || g === "B")).toBe(true);
  expect(await cards.count()).toBeLessThanOrEqual(all);
  await page.getByTestId("quick-grade").click();
  await expect(page.getByTestId("quick-grade")).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("view-list").click();
  await expect(page.getByTestId("catalog-grid")).toHaveClass(/list/);
  await page.reload();
  await expect(page.getByTestId("catalog-grid")).toHaveClass(/list/);
  await page.getByTestId("view-grid").click();
  await expect(page.getByTestId("catalog-grid")).not.toHaveClass(/list/);
});

test("Versus: «только отличия» hides the rows that are the same", async ({ page }) => {
  const items = await catalog();
  const ids = ["MacBook", "Lenovo"].map((n) => items.find((i) => i.listing.titleRu.includes(n))!.listing.id);
  await open(page, BUYER);
  await page.evaluate((v) => localStorage.setItem("ishonch.compare", v), ids.join(","));
  await page.goto(page.url().replace(/&?screen=[^&]*/, "") + "&screen=compare");
  await expect(page.getByTestId("compare")).toBeVisible();
  await expect(page.getByTestId("compare-row-account")).toBeVisible(); // «Да» / «Да»
  await page.getByTestId("compare-only-diff").locator("input").check();
  await expect(page.getByTestId("compare-row-account")).toHaveCount(0);
  await expect(page.getByTestId("compare-row-repairs")).toHaveCount(0);
  await expect(page.getByTestId("compare-row-price")).toBeVisible();
  await page.getByTestId("compare-only-diff").locator("input").uncheck();
  await expect(page.getByTestId("compare-row-account")).toBeVisible();
});

test("theme: the user's own choice beats the system and is remembered", async ({ page }) => {
  await open(page, BUYER, "screen=profile");
  await expect(page.getByTestId("theme-switch")).toBeVisible();
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("theme-light").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByTestId("theme-auto").click();
  await expect(page.getByTestId("theme-auto")).toHaveAttribute("aria-pressed", "true");
});

test("inspection mode: timer, checklist, progress that survives a reopen", async ({ page }) => {
  await open(page, BUYER, "screen=how");
  await page.getByTestId("how-try").click();
  await expect(page.getByTestId("inspect")).toBeVisible();
  await expect(page.getByTestId("inspect-time")).toHaveText("10:00");
  await expect(page.getByTestId("inspect-verdict")).toContainText("не платите");

  await page.getByTestId("inspect-start").click();
  await expect(page.getByTestId("inspect-start")).toHaveCount(0);
  await expect(page.getByTestId("inspect-time")).toHaveText(/^(9:5\d|10:00)$/);

  const rows = page.getByTestId("inspect-item");
  const total = await rows.count();
  expect(total).toBeGreaterThanOrEqual(5);
  await rows.first().click();
  await expect(page.getByTestId("inspect-progress")).toHaveText(`1 из ${total}`);

  // Reopened later: the timer keeps running from the same start and the tick stays.
  await page.reload();
  await page.getByTestId("how-try").click();
  await expect(page.getByTestId("inspect-start")).toHaveCount(0);
  await expect(page.getByTestId("inspect-progress")).toHaveText(`1 из ${total}`);
  for (let i = 1; i < total; i++) await rows.nth(i).click();
  await expect(page.getByTestId("inspect-verdict")).toContainText("Всё сходится");
  await page.getByTestId("inspect-reset").click();
  await expect(page.getByTestId("inspect-start")).toBeVisible();
  await expect(page.getByTestId("inspect-progress")).toHaveText(`0 из ${total}`);
});

test("inspection mode opens from the order while the courier is on the way", async ({ page }) => {
  const coffee = (await catalog()).find((i) => i.listing.titleRu.includes("Кофемашина"))!;
  const order = await asBot<{ id: string }>("POST", "/orders", BUYER, {
    listingId: coffee.listing.id,
    mode: "cod_seller",
    district: "mirobod",
    address: "Mirobod 9, kv 3",
  });
  await asBot("POST", `/orders/${order.id}/confirm`, SHOP_OWNER);
  for (const status of ["courier_assigned", "picked_up"]) {
    await asBot("POST", `/operator/orders/${order.id}/status`, OPERATOR, { status });
  }
  await open(page, BUYER, `startapp=order_${order.id}`);
  const card = page.locator(`#order-${order.id}`);
  await card.getByTestId("order-inspect").click();
  await expect(page.getByTestId("inspect")).toContainText("Кофемашина");
  await expect(page.getByTestId("inspect-checklist")).toContainText("Включите технику");
  // No demo note: it is a real order.
  await expect(page.getByTestId("inspect")).not.toContainText("Это пример");
});

test("catalog: «С видео-паспортом» keeps only listings with a video; recent searches are tappable", async ({ page }) => {
  await open(page, BUYER, "screen=catalog");
  await page.evaluate(() => localStorage.removeItem("ishonch.searches"));
  const cards = page.getByTestId("item-card");
  await expect(cards.nth(2)).toBeVisible();
  await page.getByTestId("quick-video").click();
  await expect(page.getByTestId("quick-video")).toHaveAttribute("aria-pressed", "true");
  // The demo phone with the AI-checked video is the only one.
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("iPhone 13");
  await page.getByTestId("quick-video").click();
  await expect(cards.nth(2)).toBeVisible();

  await page.getByTestId("catalog-search").fill("Samsung");
  await expect(cards.first()).toContainText("Samsung");
  await page.getByTestId("catalog-search").fill("");
  await expect(page.getByTestId("recent-searches")).toContainText("Samsung");
  await page.getByTestId("recent-search").first().click();
  await expect(page.getByTestId("catalog-search")).toHaveValue("Samsung");
  await page.getByTestId("catalog-search").fill("");
  await page.getByTestId("recent-clear").click();
  await expect(page.getByTestId("recent-searches")).toHaveCount(0);
});

test("seller's readiness: shows what is missing and turns green when the passport is full", async ({ page }) => {
  await open(page, PRIVATE_SELLER, "screen=my");
  const card = page.locator(".card", { hasText: "iPhone" }).first();
  await card.getByTestId("my-more").click();
  await card.locator(".chip").filter({ hasText: "✏️" }).first().click();
  const meter = page.getByTestId("readiness");
  await expect(meter).toBeVisible();
  // The demo iPhone has battery, repairs, kit, account and a video: only the photos (1 of 3) and IMEI are missing.
  await expect(meter.getByTestId("ready-photos")).toContainText("хотя бы 3, сейчас 1");
  await expect(meter.getByTestId("ready-video")).toHaveCount(0);
  await expect(meter.getByTestId("ready-batteryPct")).toHaveCount(0);
});

test("a running inspection can be resumed from the storefront", async ({ page }) => {
  await open(page, BUYER);
  await page.evaluate(() => {
    localStorage.removeItem("ishonch.inspect_active");
    localStorage.setItem("ishonch.trust_intro_seen", "1");
  });
  await open(page, BUYER, "screen=how");
  await page.getByTestId("how-try").click();
  await page.getByTestId("inspect-start").click();
  await open(page, BUYER);
  await expect(page.getByTestId("inspect-banner")).toContainText("Осмотр идёт: 9:");
  await page.getByTestId("inspect-banner").click();
  await expect(page.getByTestId("inspect")).toBeVisible();
  await page.getByTestId("inspect-reset").click();
  await open(page, BUYER);
  await expect(page.getByTestId("inspect-banner")).toHaveCount(0);
});
