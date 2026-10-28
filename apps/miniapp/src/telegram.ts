import { readPref, writePref } from "./prefs";
import {
  addToHomeScreen,
  backButton,
  closingBehavior,
  hapticFeedback,
  checkHomeScreenStatus,
  init,
  isTMA,
  miniApp,
  requestPhoneAccess,
  requestWriteAccess,
  retrieveRawInitData,
  shareStory,
  shareURL,
  retrieveLaunchParams,
  swipeBehavior,
  viewport,
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
    applyTheme();
    watchTheme();
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
  if (themeParams.mountSync.isAvailable()) themeParams.mountSync();
  applyTheme();
  watchTheme();
  if (backButton.mount.isAvailable()) backButton.mount();
  try {
    // Full height from the start, safe-area insets as CSS variables, and the page's own scroll instead of
    // the "swipe down to close" gesture (lists are long; a stray swipe must not close the app).
    if (viewport.mount.isAvailable()) {
      void viewport
        .mount()
        .then(() => {
          viewport.bindCssVars.ifAvailable();
          viewport.expand.ifAvailable();
        })
        .catch(() => undefined);
    }
    if (swipeBehavior.mount.isAvailable()) {
      swipeBehavior.mount();
      swipeBehavior.disableVertical.ifAvailable();
    }
  } catch {
    /* old client: defaults are fine */
  }

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

const DARK = "#000000";
const LIGHT = "#ffffff";
const BRAND = "#0053e2";
let brandChrome = false;

export type ThemePref = "auto" | "light" | "dark";
export function readThemePref(): ThemePref {
  const v = readPref("theme");
  return v === "light" || v === "dark" ? v : "auto";
}
/** «Тема: авто / светлая / тёмная» in the profile: saved on this device and applied at once. */
export function setThemePref(v: ThemePref) {
  writePref("theme", v);
  applyTheme();
}

/** Dark or light? The user's own choice first, else Telegram's inside the app and the system's outside. */
function isDark(): boolean {
  const pref = readThemePref();
  if (pref !== "auto") return pref === "dark";
  try {
    if (isTMA() && miniApp.isMounted()) return miniApp.isDark();
  } catch {
    /* fall through */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/**
 * Sets `data-theme` on <html> (styles.css keys every colour off it) and paints Telegram's own chrome to match:
 * the page background and the bottom bar follow the theme, the header is the brand blue on the storefront
 * and the page colour elsewhere. Re-run on every theme change.
 */
export function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (!isTMA()) return;
  try {
    const page = dark ? DARK : LIGHT;
    miniApp.setBackgroundColor.ifAvailable(page);
    miniApp.setBottomBarColor.ifAvailable(page);
    const header = brandChrome ? BRAND : page;
    if (miniApp.setHeaderColor.isAvailable()) miniApp.setHeaderColor(miniApp.setHeaderColor.supports.rgb() ? header : "bg_color");
  } catch {
    /* old client */
  }
}

/** The storefront has a blue header band; Telegram's top bar takes the same colour so the two merge. */
export function setChrome(brand: boolean) {
  if (brandChrome === brand) return;
  brandChrome = brand;
  applyTheme();
}

let themeWatched = false;
function watchTheme() {
  if (themeWatched) return;
  themeWatched = true;
  try {
    if (isTMA()) miniApp.isDark.sub(() => applyTheme());
    else window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
  } catch {
    /* unsupported */
  }
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

/** Telegram's "share to chat" sheet; outside Telegram the browser share sheet or a t.me/share link. */
export function shareLink(url: string, text: string) {
  if (shareURL.isAvailable()) return shareURL(url, text);
  const web = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  if (navigator.share) return void navigator.share({ url, text }).catch(() => undefined);
  window.open(web, "_blank");
}

export const canShareStory = () => shareStory.isAvailable();

/** Story with the listing photo and a link back to the listing (the link widget needs Telegram Premium). */
export function shareToStory(photoUrl: string, text: string, link: string, linkName: string) {
  shareStory.ifAvailable(photoUrl, { text: text.slice(0, 200), widgetLink: { url: link, name: linkName.slice(0, 48) } });
}

/** Hides Telegram's loading placeholder: called after the first render, not before. */
export function markReady() {
  try {
    if (miniApp.ready.isAvailable()) miniApp.ready();
  } catch {
    /* outside Telegram */
  }
}

/** Light tactile feedback on key actions (no-op outside Telegram / on old clients). */
export function haptic(kind: "light" | "medium" | "selection" | "success" | "warning" | "error") {
  try {
    if (kind === "selection") hapticFeedback.selectionChanged.ifAvailable();
    else if (kind === "light" || kind === "medium") hapticFeedback.impactOccurred.ifAvailable(kind);
    else hapticFeedback.notificationOccurred.ifAvailable(kind);
  } catch {
    /* unsupported */
  }
}

/** Asks "close anyway?" when the user swipes the app away with unsaved input (a draft, a checkout form). */
export function guardClosing(on: boolean) {
  try {
    if (!closingBehavior.isMounted() && closingBehavior.mount.isAvailable()) closingBehavior.mount();
    if (on) closingBehavior.enableConfirmation.ifAvailable();
    else closingBehavior.disableConfirmation.ifAvailable();
  } catch {
    /* unsupported */
  }
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
