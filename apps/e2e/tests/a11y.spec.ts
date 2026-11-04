import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { BUYER, catalog, open, resetDemo } from "./helpers";

/**
 * Accessibility gate (axe-core, WCAG 2.0 A/AA and best practices) on the screens people use, in both themes.
 * A new violation fails the build: text that cannot be read or a heading that skips a level is a regression.
 * Outside Telegram the theme follows the browser's colour scheme, so `colorScheme` switches it.
 */
test.beforeAll(resetDemo);

const SCREENS: Array<{ name: string; query: (ids: Record<string, string>) => string; prepare?: (page: Page) => Promise<void> }> = [
  { name: "home", query: () => "" },
  { name: "catalog", query: () => "screen=catalog" },
  { name: "listing", query: (ids) => `startapp=listing_${ids.listing}` },
  { name: "listing-forecast", query: (ids) => `startapp=listing_${ids.listing}`, prepare: async (p) => {
      await p.getByTestId("forecast").locator("summary").click();
      await p.getByTestId("forecast-disclaimer").waitFor();
    },
  },
  { name: "compare", query: () => "screen=compare" },
  { name: "how", query: () => "screen=how" },
  { name: "inspect", query: () => "screen=how", prepare: async (p) => {
      await p.getByTestId("how-try").click();
      await p.getByTestId("inspect").waitFor(); // a lazy screen: wait until it is really there
    },
  },
  { name: "imei", query: () => "screen=imei" },
  { name: "faq", query: () => "screen=faq" },
  { name: "profile", query: () => "screen=profile" },
  { name: "orders", query: () => "screen=orders" },
  { name: "assistant", query: () => "screen=assistant" },
  { name: "favorites", query: () => "screen=favorites" },
  { name: "valuation", query: () => "screen=valuation" },
  { name: "sell", query: () => "screen=sell" },
  { name: "check", query: () => "screen=check" },
  { name: "wanted", query: () => "screen=wanted" },
  { name: "my", query: () => "screen=my" },
];

for (const scheme of ["light", "dark"] as const) {
  test(`axe: no violations on the main screens (${scheme} theme)`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: scheme });
    const items = await catalog();
    const ids = {
      listing: items.find((i) => i.listing.titleRu.includes("Ryzen"))!.listing.id,
      compare: items
        .slice(0, 2)
        .map((i) => i.listing.id)
        .join(","),
    };
    const problems: string[] = [];
    for (const screen of SCREENS) {
      await open(page, BUYER, screen.query(ids));
      await page.evaluate((c) => {
        localStorage.setItem("ishonch.trust_intro_seen", "1");
        localStorage.setItem("ishonch.compare", c);
      }, ids.compare);
      await page.reload();
      await page.waitForSelector("main .screen:not([hidden]) h1, main .screen:not([hidden]) h2");
      await page.waitForTimeout(600);
      await screen.prepare?.(page);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "best-practice"]).analyze();
      for (const v of violations) {
        problems.push(`${screen.name}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join("; ")}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
