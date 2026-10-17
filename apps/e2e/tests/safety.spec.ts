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
