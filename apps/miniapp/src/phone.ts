import type { Api } from "./api";
import { askPhone } from "./telegram";

export type PhoneResult = "ok" | "denied" | "timeout";

/**
 * Asks Telegram to share the phone with the bot, then waits until the API has it (the contact travels
 * user → bot → API). Stops early when the screen is gone (`alive()` false), so nothing fires after leaving.
 */
export async function sharePhoneAndWait(api: Api, alive: () => boolean, seconds = 20): Promise<PhoneResult> {
  if (!(await askPhone().catch(() => false))) return "denied";
  for (let i = 0; i < seconds && alive(); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!alive()) break;
    const me = await api.me().catch(() => null);
    if (me?.hasPhone) return "ok";
  }
  return "timeout";
}
