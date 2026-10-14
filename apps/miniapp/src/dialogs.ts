import { downloadFile, miniApp, popup } from "@telegram-apps/sdk-react";

/**
 * Native Telegram dialogs. window.confirm/alert are blocked or look foreign in some Telegram clients;
 * outside Telegram (dev, browser) they are the fallback.
 */
export async function confirmDialog(message: string): Promise<boolean> {
  if (popup.show.isAvailable()) {
    const id = await popup.show({ message: message.slice(0, 256), buttons: [{ id: "ok", type: "ok" }, { id: "cancel", type: "cancel" }] });
    return id === "ok";
  }
  return window.confirm(message);
}

export async function alertDialog(message: string): Promise<void> {
  if (popup.show.isAvailable()) {
    await popup.show({ message: message.slice(0, 256), buttons: [{ type: "close" }] });
    return;
  }
  window.alert(message);
}

/**
 * Saves a file: Telegram's own download (mobile clients cannot save <a download> blobs) when supported,
 * else the browser. `url` must be absolute and work without auth headers (a short-lived signed link).
 */
export async function saveFile(url: string, fileName: string): Promise<void> {
  if (downloadFile.isAvailable()) {
    await downloadFile(url, fileName);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
}

export function closeApp() {
  if (miniApp.close.isAvailable()) miniApp.close();
  else window.location.reload();
}
