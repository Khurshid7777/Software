import { useEffect } from "react";
import { confirmDialog } from "./dialogs";
import { guardClosing } from "./telegram";

/**
 * Unsaved input protection: a screen with work in progress (photos picked, address typed) registers a
 * guard; Back, switching tabs and closing the Mini App then ask before throwing the input away.
 */
let active = 0;
let message = "";

export function useLeaveGuard(dirty: boolean, text: string) {
  useEffect(() => {
    if (!dirty) return;
    active++;
    message = text;
    guardClosing(true);
    return () => {
      active--;
      if (active === 0) guardClosing(false);
    };
  }, [dirty, text]);
}

/** true when it is fine to leave the current screen. */
export async function confirmLeave(): Promise<boolean> {
  return active === 0 || confirmDialog(message);
}

/** Runs `cb` each time a kept-alive screen comes back to the top (its data may be stale). */
export function useOnShow(visible: boolean, cb: () => void) {
  useEffect(() => {
    if (visible) cb();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
}
