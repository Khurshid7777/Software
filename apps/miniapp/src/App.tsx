import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { loadLanguage, normalizeLang, t, type CatalogFilters, type CheckResult, type Lang, type ListingDto } from "@ishonch/shared/client";
import { ApiError, createApi, SESSION_EXPIRED_EVENT, type Me } from "./api";
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
import { setBackButton, type TelegramEnv } from "./telegram";

type Screen =
  | { name: "home" }
  | { name: "check" }
  | { name: "sell"; existing?: ListingDto }
  | { name: "my" }
  | { name: "shop" }
  | { name: "listing"; id: string }
  | { name: "catalog"; filters?: CatalogFilters }
  | { name: "assistant" }
  | { name: "favorites" }
  | { name: "checkout"; listing: ListingDto }
  | { name: "orders"; focusId?: string }
  | { name: "admin" };

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
  const o = startParam?.match(/^order_([0-9a-f-]{36})$/i);
  if (o) return { name: "orders", focusId: o[1]! };
  if (startParam === "screen_orders") return { name: "orders" };
  if (startParam === "screen_admin") return { name: "admin" };
  if (startParam === "screen_sell") return { name: "sell" };
  if (startParam === "screen_my") return { name: "my" };
  if (startParam === "screen_check") return { name: "check" };
  if (startParam === "screen_catalog") return { name: "catalog" };
  if (startParam === "screen_assistant") return { name: "assistant" };
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

  // Navigation is a stack: "Back" returns to where the user came from (catalog with its filters, the
  // listing after checkout…), not always Home. A deep link starts as Home → target.
  const [stack, setStack] = useState<Screen[]>(() => {
    const first = initialScreen(env.startParam);
    return first.name === "home" ? [first] : [{ name: "home" }, first];
  });
  const screen = stack[stack.length - 1]!;
  const go = useCallback((s: Screen) => setStack((st) => [...st, s]), []);
  /** Replaces the current screen (after checkout → orders, Back leads to the listing, not the form). */
  const replace = useCallback((s: Screen) => setStack((st) => [...st.slice(0, -1), s]), []);
  const back = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);
  const home = useCallback(() => setStack([{ name: "home" }]), []);

  /** Switches language after its dictionary is downloaded (only the active language is loaded). */
  const switchLanguage = useCallback(async (l: Lang) => {
    await loadLanguage(l).catch(() => undefined);
    setLang(l);
  }, []);

  useEffect(() => {
    api
      .me()
      .then(async (m) => {
        await switchLanguage(m.language);
        setMe(m);
      })
      .catch(() => setError(t(lang, "common.error")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // initData is valid for a few hours; after that every call is 401 → ask to reopen the app.
  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => setBackButton(stack.length > 1 ? back : null), [stack.length, back]);

  // Bot button "Find similar" → similar_<checkId>: open the catalog with the checked item.
  useEffect(() => {
    const m = env.startParam?.match(/^similar_([0-9a-f-]{36})$/i);
    if (m) api.getCheck(m[1]!).then((c) => go({ name: "catalog", filters: similarFilters(c) })).catch(() => undefined);
  }, [api, env.startParam, go]);

  async function acceptTerms() {
    setBusy(true);
    await api.acceptTerms().catch(() => undefined);
    setMe((m) => (m ? { ...m, acceptedTerms: true } : m));
    setBusy(false);
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
  else if (error) content = <p className="error center">{error}</p>;
  else if (!me) content = <p className="center hint">{t(lang, "common.loading")}</p>;
  else if (!me.acceptedTerms) content = <Terms onAccept={acceptTerms} busy={busy} />;
  else {
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
            key={screen.existing?.id ?? "new"}
            api={api}
            existing={screen.existing}
            onDone={() => replace({ name: "my" })}
          />
        );
        break;
      case "my":
        body = (
          <MyListings
            api={api}
            onEdit={(l) => go({ name: "sell", existing: l })}
            onOpen={(id) => go({ name: "listing", id })}
          />
        );
        break;
      case "shop":
        body = <Shop api={api} />;
        break;
      case "listing":
        body = (
          <ListingView
            key={screen.id}
            api={api}
            id={screen.id}
            meId={me.id}
            onBuy={(listing) => go({ name: "checkout", listing })}
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
        body = <Orders api={api} focusId={screen.focusId} onOpenListing={(id) => go({ name: "listing", id })} />;
        break;
      case "catalog":
        body = (
          <Catalog
            key={stack.length}
            api={api}
            initial={screen.filters}
            onFiltersChange={(filters) => replace({ name: "catalog", filters })}
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
            onOpen={(id) => go({ name: "listing", id })}
            onSearch={(s) => go({ name: "catalog", filters: s.filters })}
          />
        );
        break;
      default:
        body = (
          <Home
            staff={me.role === "admin" ? "admin" : me.role === "operator" ? "operator" : null}
            remaining={me.checks.remaining}
            onOpen={(name) => go({ name } as Screen)}
            onLanguage={changeLanguage}
            onDeleteAccount={deleteAccount}
          />
        );
    }
    // Inside Telegram the native Back button is shown; the in-page link is for the browser (dev).
    content =
      stack.length === 1 || env.inTelegram ? (
        body
      ) : (
        <>
          <div className="row">
            <button className="link" onClick={back}>
              ← {t(lang, "common.back")}
            </button>
            {stack.length > 2 && (
              <button className="link" onClick={home}>
                ⌂
              </button>
            )}
          </div>
          {body}
        </>
      );
  }

  return (
    <LangContext.Provider value={lang}>
      <main className="app">
        <ErrorBoundary key={`${stack.length}-${screen.name}`} message={t(lang, "app.crashed")} action={t(lang, "app.reload")}>
          {content}
        </ErrorBoundary>
      </main>
    </LangContext.Provider>
  );
}
