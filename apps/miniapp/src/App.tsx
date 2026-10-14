import { useEffect, useMemo, useState } from "react";
import { normalizeLang, type CatalogFilters, type CheckResult, type Lang, type ListingDto } from "@ishonch/shared";
import { t } from "@ishonch/shared/i18n";
import { createApi, type Me } from "./api";
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
  | { name: "orders"; focusId?: string };

/** "Find similar at verified sellers" from a check result. */
export function similarFilters(check: Pick<CheckResult, "title" | "category">): CatalogFilters {
  return { q: check.title, category: check.category === "other" ? undefined : check.category, verifiedOnly: true };
}

/** Start params: `listing_<uuid>` (channel button), `order_<uuid>` (order notifications), `screen_*` (bot buttons). */
function initialScreen(startParam?: string): Screen {
  const m = startParam?.match(/^listing_([0-9a-f-]{36})$/i);
  if (m) return { name: "listing", id: m[1]! };
  const o = startParam?.match(/^order_([0-9a-f-]{36})$/i);
  if (o) return { name: "orders", focusId: o[1]! };
  if (startParam === "screen_orders") return { name: "orders" };
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
  const [screen, setScreen] = useState<Screen>(() => initialScreen(env.startParam));
  const [deleted, setDeleted] = useState(false);
  const home = () => setScreen({ name: "home" });

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        setLang(m.language);
      })
      .catch(() => setError(t(lang, "common.error")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => setBackButton(screen.name === "home" ? null : home), [screen]);

  // Bot button "Find similar" → similar_<checkId>: open the catalog with the checked item.
  useEffect(() => {
    const m = env.startParam?.match(/^similar_([0-9a-f-]{36})$/i);
    if (m) api.getCheck(m[1]!).then((c) => setScreen({ name: "catalog", filters: similarFilters(c) })).catch(() => undefined);
  }, [api, env.startParam]);

  async function acceptTerms() {
    setBusy(true);
    await api.acceptTerms().catch(() => undefined);
    setMe((m) => (m ? { ...m, acceptedTerms: true } : m));
    setBusy(false);
  }

  async function changeLanguage(l: Lang) {
    setLang(l);
    await api.setLanguage(l).catch(() => undefined);
  }

  async function deleteAccount() {
    if (!window.confirm(t(lang, "home.delete_confirm"))) return;
    await api.deleteAccount();
    setDeleted(true);
  }

  let content;
  if (deleted) content = <p className="center">{t(lang, "home.deleted")}</p>;
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
            onSimilar={(c) => setScreen({ name: "catalog", filters: similarFilters(c) })}
          />
        );
        break;
      case "sell":
        body = (
          <Sell
            key={screen.existing?.id ?? "new"}
            api={api}
            existing={screen.existing}
            onDone={() => setScreen({ name: "my" })}
          />
        );
        break;
      case "my":
        body = (
          <MyListings
            api={api}
            onEdit={(l) => setScreen({ name: "sell", existing: l })}
            onOpen={(id) => setScreen({ name: "listing", id })}
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
            onBuy={(listing) => setScreen({ name: "checkout", listing })}
          />
        );
        break;
      case "checkout":
        body = <Checkout api={api} listing={screen.listing} onDone={(id) => setScreen({ name: "orders", focusId: id })} />;
        break;
      case "orders":
        body = <Orders api={api} focusId={screen.focusId} onOpenListing={(id) => setScreen({ name: "listing", id })} />;
        break;
      case "catalog":
        body = (
          <Catalog
            key={JSON.stringify(screen.filters ?? {})}
            api={api}
            initial={screen.filters}
            onOpen={(id) => setScreen({ name: "listing", id })}
          />
        );
        break;
      case "assistant":
        body = <Assistant api={api} onOpen={(id) => setScreen({ name: "listing", id })} />;
        break;
      case "favorites":
        body = (
          <Favorites
            api={api}
            onOpen={(id) => setScreen({ name: "listing", id })}
            onSearch={(s) => setScreen({ name: "catalog", filters: s.filters })}
          />
        );
        break;
      default:
        body = (
          <Home
            remaining={me.checks.remaining}
            onOpen={(name) => setScreen({ name } as Screen)}
            onLanguage={changeLanguage}
            onDeleteAccount={deleteAccount}
          />
        );
    }
    content =
      screen.name === "home" ? (
        body
      ) : (
        <>
          <button className="link" onClick={home}>
            ← {t(lang, "common.back")}
          </button>
          {body}
        </>
      );
  }

  return (
    <LangContext.Provider value={lang}>
      <main className="app">{content}</main>
    </LangContext.Provider>
  );
}
