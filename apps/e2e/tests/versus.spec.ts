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

test("Forecast: «Что будет с устройством» on the listing — usage and horizon change the numbers, estimate disclaimer is shown", async ({ page }) => {
  const phone = (await catalog()).find((i) => i.listing.titleRu.includes("Lenovo"))!;
  await open(page, BUYER, `startapp=listing_${phone.listing.id}`);
  await page.evaluate(() => {
    localStorage.removeItem("ishonch.forecast_usage");
    localStorage.removeItem("ishonch.forecast_years");
  });
  await page.reload();
  const card = page.getByTestId("forecast");
  await expect(card).toBeVisible();
  await card.locator("summary").click();
  await expect(page.getByTestId("forecast-disclaimer")).toContainText(/оценк|предполож/i);
  await expect(page.getByTestId("forecast-price")).toContainText(/\d/);
  await expect(page.getByTestId("forecast-chart").first()).toBeVisible();

  const battery = async () => (await page.getByTestId("forecast-battery").locator(".forecast-line").first().textContent()) ?? "";
  await page.getByTestId("usage-light").click();
  const light = await battery();
  await page.getByTestId("usage-heavy").click();
  const heavy = await battery();
  expect(heavy).not.toBe(light);
  expect(Number(light.match(/(\d+)%/)![1])).toBeGreaterThan(Number(heavy.match(/(\d+)%/)![1]));
  await page.getByTestId("years-5").click();
  await expect(page.getByTestId("years-5")).toHaveAttribute("aria-pressed", "true");
});

test("Forecast in the comparison: battery / first service / price rows, chart toggle and the shared settings", async ({ page }) => {
  const items = await catalog();
  await open(page, BUYER, "screen=compare");
  await page.evaluate((ids) => localStorage.setItem("ishonch.compare", ids.join(",")), items.slice(0, 3).map((i) => i.listing.id));
  await page.reload();
  await expect(page.getByTestId("compare")).toBeVisible();
  for (const row of ["fc_battery", "fc_service", "fc_price"]) {
    await expect(page.getByTestId(`compare-row-${row}`).locator("td")).toHaveCount(3);
  }
  await expect(page.getByTestId("compare-forecast")).toContainText(/предполож|оценк/i);
  await expect(page.getByTestId("forecast-chart")).toBeVisible();
  const before = await page.getByTestId("compare-row-fc_price").textContent();
  await page.getByTestId("years-5").click();
  await expect.poll(async () => page.getByTestId("compare-row-fc_price").textContent()).not.toBe(before);
  // Touching the chart shows another year: the legend values follow the pointer.
  const legend = page.getByTestId("compare-forecast").locator(".chart-legend");
  const atEnd = await legend.textContent();
  const box = (await page.getByTestId("compare-forecast").locator(".mini-chart svg").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await expect.poll(async () => legend.textContent()).not.toBe(atEnd);
  await page.getByTestId("chart-battery").click();
  await expect(page.getByTestId("chart-battery")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("forecast-chart")).toBeVisible();
});
