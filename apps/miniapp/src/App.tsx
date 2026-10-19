import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loadLanguage, normalizeLang, t, type CatalogFilters, type CheckResult, type Lang, type ListingDto } from "@ishonch/shared/client";
import { ApiError, createApi, SESSION_EXPIRED_EVENT, setApiLang, type Me } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { alertDialog, closeApp, confirmDialog } from "./dialogs";
import { LangContext } from "./i18n";
import { Assistant } from "./screens/Assistant";
import { Catalog } from "./screens/Catalog";
import { Check } from "./screens/Check";
import { Checkout } from "./screens/Checkout";
import { Favorites } from "./screens/Favorites";
import { Home } from "./screens/Home";
import { ListingView } from "./screens/ListingView";
import { MyListings } from "./screens/MyListings";
import { Orders } from "./screens/Orders";
import { Sell } from "./screens/Sell";
import { Shop } from "./screens/Shop";
import { Terms } from "./screens/Terms";
import { Profile } from "./screens/Profile";
import { SellerPage } from "./screens/SellerPage";
import { Blocks } from "./screens/Blocks";
import { Wanted } from "./screens/Wanted";
import { Stolen } from "./screens/Stolen";
import { Away } from "./screens/Away";
import { Notifications } from "./screens/Notifications";
import { Valuation } from "./screens/Valuation";
import { TabBar, type Tab } from "./components/TabBar";
import { confirmLeave } from "./leave";
import { setBackButton, type TelegramEnv } from "./telegram";

type Screen =
  | { name: "home" }
  | { name: "check" }
  | { name: "sell"; existing?: ListingDto }
  | { name: "my" }
  | { name: "shop" }
  | { name: "blocks" }
  | { name: "wanted" }
  | { name: "stolen" }
  | { name: "away" }
  | { name: "notifications" }
  | { name: "listing"; id: string }
  | { name: "catalog"; filters?: CatalogFilters }
  | { name: "assistant" }
  | { name: "favorites" }
  | { name: "checkout"; listing: ListingDto }
  | { name: "orders"; focusId?: string }
  | { name: "profile" }
  | { name: "seller"; id: string }
  | { name: "valuation" }
  | { name: "admin" };

/** A navigation entry: screens below the top stay mounted (state, loaded lists) and remember their scroll. */
interface Entry {
  key: number;
  screen: Screen;
}
let nextKey = 1;
const entry = (screen: Screen): Entry => ({ key: nextKey++, screen });

/** Which bottom tab a top-level screen belongs to. */
const TAB_OF: Partial<Record<Screen["name"], Tab>> = {
  home: "home",
  catalog: "catalog",
  sell: "sell",
  orders: "orders",
  profile: "profile",
  my: "profile",
  shop: "profile",
  favorites: "profile",
};

/** "Find similar at verified sellers" from a check result. */
export function similarFilters(check: Pick<CheckResult, "title" | "category">): CatalogFilters {
  return { q: check.title, category: check.category === "other" ? undefined : check.category, verifiedOnly: true };
}

// Staff-only panel: a separate chunk, buyers and sellers never download it.
const Admin = lazy(() => import("./screens/admin/Admin").then((m) => ({ default: m.Admin })));

/** Start params: `listing_<uuid>` (channel button), `order_<uuid>` (order notifications), `screen_*` (bot buttons). */
function initialScreen(startParam?: string): Screen {
  const m = startParam?.match(/^listing_([0-9a-f-]{36})$/i);
  if (m) return { name: "listing", id: m[1]! };
  const sp = startParam?.match(/^seller_([0-9a-f-]{36})$/i);
  if (sp) return { name: "seller", id: sp[1]! };
  const o = startParam?.match(/^order_([0-9a-f-]{36})$/i);
  if (o) return { name: "orders", focusId: o[1]! };
  if (startParam === "screen_orders") return { name: "orders" };
  if (startParam === "screen_admin") return { name: "admin" };
  if (startParam === "screen_sell") return { name: "sell" };
  if (startParam === "screen_my") return { name: "my" };
  if (startParam === "screen_wanted") return { name: "wanted" };
  if (startParam === "screen_shop") return { name: "shop" };
  if (startParam === "screen_check") return { name: "check" };
  if (startParam === "screen_catalog") return { name: "catalog" };
  if (startParam === "screen_assistant") return { name: "assistant" };
  if (startParam === "screen_favorites") return { name: "favorites" };
  if (startParam === "screen_profile") return { name: "profile" };
  if (startParam === "screen_notifications") return { name: "notifications" };
  if (startParam === "screen_shop") return { name: "shop" };
  if (startParam === "screen_valuation") return { name: "valuation" };
  return { name: "home" };
}

export function App({ env }: { env: TelegramEnv }) {
  const api = useMemo(() => createApi(env.initData), [env.initData]);
  const [me, setMe] = useState<Me | null>(null);
  const [lang, setLang] = useState<Lang>(normalizeLang(env.languageCode));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [expired, setExpired] = useState(false);

  // Navigation is a stack: "Back" returns to where the user came from (catalog with its filters and scroll,
  // the listing after checkout…). Screens under the top stay mounted, so going back is instant.
  // A deep link starts as Home → target; tab roots (Home, Catalog, Sell, Orders, Profile) start a new stack.
  const [stack, setStack] = useState<Entry[]>(() => {
    const first = initialScreen(env.startParam);
    return first.name === "home" || first.name === "profile" ? [entry(first)] : [entry({ name: "home" }), entry(first)];
  });
  const top = stack[stack.length - 1]!;
  const screen = top.screen;
  // Scroll position of every entry, saved when the user leaves it and restored when they come back.
  const scrolls = useRef(new Map<number, number>());
  const pending = useRef<number | null>(null);
  const go = useCallback(
    (s: Screen) => {
      scrolls.current.set(top.key, window.scrollY);
      pending.current = 0;
      setStack((st) => [...st, entry(s)]);
    },
    [top.key],
  );
  /** Replaces the current screen (after checkout → orders, Back leads to the listing, not the form). */
  const replace = useCallback((s: Screen) => {
    pending.current = 0;
    setStack((st) => [...st.slice(0, -1), entry(s)]);
  }, []);
  /** Same screen, new parameters (catalog filters): stays mounted, keeps its scroll. */
  const update = useCallback((key: number, s: Screen) => setStack((st) => st.map((e) => (e.key === key ? { ...e, screen: s } : e))), []);
  const back = useCallback(async () => {
    if (stack.length < 2 || !(await confirmLeave())) return;
    pending.current = scrolls.current.get(stack[stack.length - 2]!.key) ?? 0;
    setStack((st) => st.slice(0, -1));
  }, [stack]);
  /** After saving an edit started from "My listings", Back to that list (not a second copy of it). */
  const finishSell = useCallback(() => {
    pending.current = 0;
    setStack((st) =>
      st.length > 1 && st[st.length - 2]!.screen.name === "my" ? st.slice(0, -1) : [...st.slice(0, -1), entry({ name: "my" })],
    );
  }, []);
  const home = useCallback(() => {
    pending.current = 0;
    setStack([entry({ name: "home" })]);
  }, []);
  const openTab = useCallback(
    async (tab: Tab) => {
      // Tapping the active tab again scrolls it to the top (like native apps).
      if (stack.length === 1 && TAB_OF[screen.name] === tab) return window.scrollTo({ top: 0, behavior: "smooth" });
      if (!(await confirmLeave())) return;
      pending.current = 0;
      setStack([entry({ name: tab } as Screen)]);
    },
    [stack.length, screen.name],
  );
  useLayoutEffect(() => {
    if (pending.current === null) return;
    window.scrollTo(0, pending.current);
    pending.current = null;
  }, [stack]);

  /** Switches language after its dictionary is downloaded (only the active language is loaded). */
  const switchLanguage = useCallback(async (l: Lang) => {
    await loadLanguage(l).catch(() => undefined);
    setLang(l);
  }, []);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    api
      .me()
      .then(async (m) => {
        await switchLanguage(m.language);
        setMe(m);
      })
      .catch(() => setError(t(lang, "common.load_error")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, attempt]);
  useEffect(() => setApiLang(lang), [lang]);

  // initData is valid for a few hours; after that every call is 401 → ask to reopen the app.
  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => setBackButton(stack.length > 1 ? () => void back() : null), [stack.length, back]);
  const tabbar = stack.length === 1 && !!TAB_OF[screen.name];

  // Bot button "Find similar" → similar_<checkId>: open the catalog with the checked item.
  useEffect(() => {
    const m = env.startParam?.match(/^similar_([0-9a-f-]{36})$/i);
    if (m) api.getCheck(m[1]!).then((c) => go({ name: "catalog", filters: similarFilters(c) })).catch(() => undefined);
  }, [api, env.startParam, go]);

  async function acceptTerms() {
    setBusy(true);
    try {
      await api.acceptTerms();
      setMe((m) => (m ? { ...m, acceptedTerms: true } : m));
    } catch (e) {
      await alertDialog(e instanceof ApiError ? e.message : t(lang, "common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function changeLanguage(l: Lang) {
    await switchLanguage(l);
    await api.setLanguage(l).catch(() => undefined);
  }

  async function deleteAccount() {
    if (!(await confirmDialog(t(lang, "home.delete_confirm")))) return;
    try {
      await api.deleteAccount();
      setDeleted(true);
    } catch (e) {
      await alertDialog(e instanceof ApiError ? e.message : t(lang, "common.error")); // e.g. open orders first
    }
  }

  let content;
  if (expired)
    content = (
      <div className="stack center">
        <p>{t(lang, "app.session_expired")}</p>
        <button className="primary" onClick={closeApp}>
          {t(lang, "app.close")}
        </button>
      </div>
    );
  else if (deleted) content = <p className="center">{t(lang, "home.deleted")}</p>;
  else if (error)
    content = (
      <div className="empty">
        <span className="empty-icon">📡</span>
        <p className="hint">{error}</p>
        <button className="secondary" onClick={() => setAttempt((a) => a + 1)}>
          {t(lang, "common.retry")}
        </button>
      </div>
    );
  else if (!me) content = <p className="center hint">{t(lang, "common.loading")}</p>;
  else if (!me.acceptedTerms) content = <Terms onAccept={acceptTerms} busy={busy} />;
  else {
    const render = (screen: Screen, key: number, visible: boolean) => {
    let body;
    switch (screen.name) {
      case "check":
        body = (
          <Check
            api={api}
            remaining={me.checks.remaining}
            onDone={(remaining) => setMe({ ...me, checks: { ...me.checks, remaining } })}
            onSimilar={(c) => go({ name: "catalog", filters: similarFilters(c) })}
          />
        );
        break;
      case "sell":
        body = (
          <Sell
            api={api}
            existing={screen.existing}
            onDone={finishSell}
          />
        );
        break;
      case "my":
        body = (
          <MyListings
            api={api}
            visible={visible}
            onEdit={(l) => go({ name: "sell", existing: l })}
            onOpen={(id) => go({ name: "listing", id })}
            onSell={() => go({ name: "sell" })}
            onWanted={() => go({ name: "wanted" })}
          />
        );
        break;
      case "shop":
        body = <Shop api={api} onOpen={(id) => go({ name: "listing", id })} />;
        break;
      case "blocks":
        body = <Blocks api={api} />;
        break;
      case "away":
        body = <Away api={api} />;
        break;
      case "stolen":
        body = <Stolen api={api} />;
        break;
      case "wanted":
        body = <Wanted api={api} onSell={() => go({ name: "sell" })} />;
        break;
      case "notifications":
        body = <Notifications api={api} />;
        break;
      case "listing":
        body = (
          <ListingView
            api={api}
            id={screen.id}
            meId={me.id}
            onBuy={(listing) => go({ name: "checkout", listing })}
            onEdit={(listing) => go({ name: "sell", existing: listing })}
            onOpen={(id) => go({ name: "listing", id })}
            onSeller={(id) => go({ name: "seller", id })}
          />
        );
        break;
      case "checkout":
        body = <Checkout api={api} listing={screen.listing} onDone={(id) => replace({ name: "orders", focusId: id })} />;
        break;
      case "admin":
        body =
          me.role === "admin" || me.role === "operator" ? (
            <Suspense fallback={<p className="center hint">{t(lang, "common.loading")}</p>}>
              <Admin api={api} role={me.role} onOpenListing={(id) => go({ name: "listing", id })} />
            </Suspense>
          ) : (
            <p className="hint center">{t(lang, "common.error")}</p>
          );
        break;
      case "orders":
        body = (
          <Orders
            api={api}
            visible={visible}
            focusId={screen.focusId}
            onOpenListing={(id) => go({ name: "listing", id })}
            onCatalog={() => go({ name: "catalog" })}
            onSell={() => go({ name: "sell" })}
          />
        );
        break;
      case "catalog":
        body = (
          <Catalog
            api={api}
            initial={screen.filters}
            onFiltersChange={(filters) => update(key, { name: "catalog", filters })}
            onOpen={(id) => go({ name: "listing", id })}
          />
        );
        break;
      case "assistant":
        body = <Assistant api={api} onOpen={(id) => go({ name: "listing", id })} />;
        break;
      case "favorites":
        body = (
          <Favorites
            api={api}
            visible={visible}
            onOpen={(id) => go({ name: "listing", id })}
            onSearch={(s) => go({ name: "catalog", filters: s.filters })}
            onCatalog={() => go({ name: "catalog" })}
            onSeller={(id) => go({ name: "seller", id })}
          />
        );
        break;
      case "valuation":
        body = <Valuation api={api} onSell={() => go({ name: "sell" })} />;
        break;
      case "seller":
        body = <SellerPage api={api} sellerId={screen.id} onOpen={(id) => go({ name: "listing", id })} />;
        break;
      case "profile":
        body = (
          <Profile
            staff={staff}
            hasPhone={me.hasPhone}
            onOpen={(name) => go({ name } as Screen)}
            onLanguage={changeLanguage}
            onDeleteAccount={deleteAccount}
            onExport={() =>
              api
                .exportData()
                .then(() => alertDialog(t(lang, "export.sent")))
                .catch((e) => alertDialog(e instanceof ApiError ? e.message : t(lang, "common.error")))
            }
          />
        );
        break;
      default:
        body = (
          <Home
            api={api}
            staff={staff}
            remaining={me.checks.remaining}
            onOpen={(name) => go({ name } as Screen)}
            onCatalog={(filters) => go({ name: "catalog", filters })}
            onListing={(id) => go({ name: "listing", id })}
          />
        );
    }
    return body;
    };
    const staff = me.role === "admin" ? "admin" : me.role === "operator" ? "operator" : null;
    // Every entry of the stack is rendered; only the top one is visible (the rest keep their state).
    const screens = stack.map((e, idx) => (
      <section key={e.key} hidden={idx !== stack.length - 1} className="screen">
        <ErrorBoundary message={t(lang, "app.crashed")} action={t(lang, "app.reload")}>
          {render(e.screen, e.key, idx === stack.length - 1)}
        </ErrorBoundary>
      </section>
    ));
    // Inside Telegram the native Back button is shown; the in-page link is for the browser (dev).
    // The tree keeps the same shape either way: changing it would remount (and reset) every screen.
    content = (
      <>
        {stack.length > 1 && !env.inTelegram && (
          <div className="row">
            <button className="link" onClick={() => void back()}>
              ← {t(lang, "common.back")}
            </button>
            {stack.length > 2 && (
              <button className="link" onClick={home}>
                ⌂
              </button>
            )}
          </div>
        )}
        {screens}
      </>
    );
  }

  return (
    <LangContext.Provider value={lang}>
      <main className={tabbar ? "app with-tabbar" : "app"}>{content}</main>
      {tabbar && me?.acceptedTerms && <TabBar active={TAB_OF[screen.name] ?? null} onSelect={(tab) => void openTab(tab)} />}
    </LangContext.Provider>
  );
}
