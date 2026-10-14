import {
  addToHomeScreen,
  backButton,
  checkHomeScreenStatus,
  init,
  isTMA,
  miniApp,
  requestPhoneAccess,
  requestWriteAccess,
  retrieveRawInitData,
  retrieveLaunchParams,
  themeParams,
} from "@telegram-apps/sdk-react";

export interface TelegramEnv {
  inTelegram: boolean;
  initData: string | null;
  languageCode?: string;
  /** t.me/<bot>?startapp=<param> or ?screen=<name> for buttons from the bot. */
  startParam?: string;
}

/**
 * Initialises the Telegram SDK. Outside Telegram (local dev / Playwright) we fall back to
 * `?initData=` in the URL or VITE_DEV_INIT_DATA so the API signature check still runs.
 */
export function initTelegram(): TelegramEnv {
  if (!isTMA()) {
    const fromUrl = new URLSearchParams(window.location.search).get("initData");
    const initData = fromUrl ?? import.meta.env.VITE_DEV_INIT_DATA ?? null;
    let languageCode: string | undefined;
    try {
      languageCode = initData ? JSON.parse(new URLSearchParams(initData).get("user") ?? "{}").language_code : undefined;
    } catch {
      /* ignore */
    }
    const startParam = new URLSearchParams(window.location.search).get("startapp") ?? screenParam();
    return { inTelegram: false, initData, languageCode, startParam: startParam ?? undefined };
  }

  init();
  if (miniApp.mountSync.isAvailable()) miniApp.mountSync();
  if (themeParams.mountSync.isAvailable()) {
    themeParams.mountSync();
    if (themeParams.bindCssVars.isAvailable()) themeParams.bindCssVars();
  }
  if (backButton.mount.isAvailable()) backButton.mount();
  if (miniApp.ready.isAvailable()) miniApp.ready();

  const lp = retrieveLaunchParams();
  return {
    inTelegram: true,
    initData: retrieveRawInitData() ?? null,
    languageCode: lp.tgWebAppData?.user?.language_code,
    // t.me/<bot>?startapp=… arrives as tgWebAppStartParam; bot web_app buttons pass ?startapp= / ?screen= in the URL.
    startParam:
      lp.tgWebAppStartParam ?? new URLSearchParams(window.location.search).get("startapp") ?? screenParam() ?? undefined,
  };
}

function screenParam() {
  const s = new URLSearchParams(window.location.search).get("screen");
  return s ? `screen_${s}` : null;
}

/**
 * Asks Telegram to share the user's phone with the bot. Telegram delivers it to the bot as a
 * contact message (trusted), the bot stores it via the internal API. Returns false if unsupported.
 */
export async function askPhone(): Promise<boolean> {
  if (!requestPhoneAccess.isAvailable()) return false;
  const status = await requestPhoneAccess();
  return status === "sent";
}

/** The bot can only DM users who allowed it; needed to deliver seller replies. */
export async function ensureWriteAccess(): Promise<boolean> {
  if (!requestWriteAccess.isAvailable()) return true; // outside Telegram or old client: nothing to ask
  try {
    return (await requestWriteAccess()) === "allowed";
  } catch {
    return false;
  }
}

/** True when Telegram can pin the app to the phone's home screen and it is not pinned yet (Mini Apps 8.0+). */
export async function canAddToHomeScreen(): Promise<boolean> {
  if (!addToHomeScreen.isAvailable() || !checkHomeScreenStatus.isAvailable()) return false;
  try {
    return (await checkHomeScreenStatus()) === "missed";
  } catch {
    return false;
  }
}

export function promptAddToHomeScreen() {
  addToHomeScreen.ifAvailable();
}

export function setBackButton(onClick: (() => void) | null) {
  if (!backButton.isMounted()) return () => {};
  if (!onClick) {
    backButton.hide();
    return () => {};
  }
  backButton.show();
  return backButton.onClick(onClick);
}
