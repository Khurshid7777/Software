import { useEffect, useState } from "react";
import { CHECK_CATEGORIES, type CatalogFilters, type CatalogItem } from "@ishonch/shared/client";
import type { Api } from "../api";
import { Icon } from "../components/Icon";
import { MiniCard, MiniCardSkeleton } from "../components/MiniCard";
import { LoadError } from "../components/LoadError";
import { useT } from "../i18n";
import { readPref, readRecent, writePref } from "../prefs";
import { canAddToHomeScreen, haptic, promptAddToHomeScreen } from "../telegram";

/** Category circles on the storefront (the catch-all ones live in the catalog filters). */
export const CATEGORY_ICONS: Record<string, string> = {
  smartphone: "📱",
  laptop: "💻",
  tablet: "📲",
  headphones: "🎧",
  smartwatch: "⌚️",
  console: "🎮",
  tv: "📺",
  camera: "📷",
  pc_parts: "🧩",
  monitor: "🖥️",
  home_appliance: "🏠",
  large_appliance: "🧊",
};
const CATEGORIES = CHECK_CATEGORIES.filter((c) => c in CATEGORY_ICONS);
/** The "below market" rail: listings priced at least this much under the reference. */
const DEALS_PCT = 10;

interface Props {
  api: Api;
  /** Staff see an entry to the admin panel (operators: delivery orders only). */
  staff?: "admin" | "operator" | null;
  remaining: number;
  onOpen: (screen: "check" | "sell" | "assistant" | "favorites" | "admin" | "valuation") => void;
  onCatalog: (filters?: CatalogFilters) => void;
  onListing: (id: string) => void;
}

/**
 * Storefront, top to bottom: the blue brand bar with the search, the "how we protect you" hero, category
 * circles, the below-market rail, the tools, recently viewed, fresh listings and the sell banner.
 */
export function Home({ api, staff, remaining, onOpen, onCatalog, onListing }: Props) {
  const t = useT();
  const [fresh, setFresh] = useState<CatalogItem[] | null>(null);
  const [deals, setDeals] = useState<CatalogItem[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [homeScreen, setHomeScreen] = useState(false);
  const [recent, setRecent] = useState<CatalogItem[]>([]);
  // New users see once how a purchase is protected; one tap hides it for good on this device.
  const [howTo, setHowTo] = useState(() => readPref("trust_intro_seen") !== "1");

  useEffect(() => {
    let current = true;
    api
      .catalog({}, "newest", 0)
      .then((p) => current && setFresh(p.items.slice(0, 6)))
      .catch(() => current && (setFresh([]), setFailed(true)));
    api
      .catalog({ belowMarketPct: DEALS_PCT }, "relevance", 0)
      .then((p) => current && setDeals(p.items.slice(0, 8)))
      .catch(() => undefined);
    canAddToHomeScreen().then((v) => current && setHomeScreen(v));
    api
      .catalogBatch(readRecent())
      .then((items) => current && setRecent(items))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [api, attempt]);

  const rail = (items: CatalogItem[], testId?: string) => (
    <div className="rail scroll-x bleed" data-testid={testId}>
      {items.map((i) => (
        <MiniCard key={i.listing.id} item={i} onOpen={() => onListing(i.listing.id)} />
      ))}
    </div>
  );

  return (
    <div className="stack home" data-testid="home">
      <header className="brand-bar">
        <div className="brand-row">
          <span className="brand-logo">
            {t("app.name")}
            <span className="spark" aria-hidden>
              ✦
            </span>
          </span>
        </div>
        <span className="brand-tagline">{t("app.tagline")}</span>
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            onCatalog(query.trim() ? { q: query.trim() } : undefined);
          }}
        >
          <Icon name="search" />
          <input
            type="search"
            enterKeyHint="search"
            placeholder={t("catalog.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="home-search"
          />
          <button type="submit" className="search-go" aria-label={t("home.search_go")}>
            <Icon name="arrow" />
          </button>
        </form>
      </header>

      {howTo && (
        <section className="hero" data-testid="trust-intro">
          <h2>{t("home.trust.title")}</h2>
          <button
            className="hero-close"
            aria-label={t("home.trust.close")}
            onClick={() => {
              writePref("trust_intro_seen", "1");
              setHowTo(false);
            }}
            data-testid="trust-intro-close"
          >
            <Icon name="close" />
          </button>
          <ul className="trust-steps">
            <li>
              <Icon name="check" /> {t("home.trust.step1")}
            </li>
            <li>
              <Icon name="check" /> {t("home.trust.step2")}
            </li>
            <li>
              <Icon name="check" /> {t("home.trust.step3")}
            </li>
          </ul>
          <button className="hero-cta" onClick={() => onCatalog({})}>
            {t("home.hero.cta")} <Icon name="arrow" />
          </button>
        </section>
      )}

      <div className="category-strip scroll-x bleed" role="list">
        {CATEGORIES.map((c) => (
          <button key={c} role="listitem" className="category" onClick={() => onCatalog({ category: c })}>
            <span className="category-icon" aria-hidden>
              {CATEGORY_ICONS[c]}
            </span>
            <span>{t(`category.${c}`)}</span>
          </button>
        ))}
      </div>

      {deals.length > 0 && (
        <section className="section" data-testid="deals">
          <div className="section-head">
            <h2>📉 {t("home.deals")}</h2>
            <button className="link" onClick={() => onCatalog({ belowMarketPct: DEALS_PCT })}>
              {t("home.see_all")} ›
            </button>
          </div>
          {rail(deals)}
        </section>
      )}

      {staff && (
        <button className="tile primary-tile" onClick={() => onOpen("admin")} data-testid="open-admin">
          <span className="tile-icon">🛠</span>
          <span>
            <strong>{staff === "admin" ? "Админка" : "Заказы на доставку"}</strong>
            <span className="hint">{staff === "admin" ? "Метрики, модерация, заказы, пользователи" : "Курьеры и статусы"}</span>
          </span>
        </button>
      )}

      <section className="section">
        <h2>{t("home.tools")}</h2>
        <div className="tools">
          <button className="tool primary-quick" onClick={() => onOpen("check")} data-testid="open-check">
            <span className="tool-icon">🔎</span>
            <strong>{t("home.quick.check_title")}</strong>
            <span className="hint">{t("home.quick.check", { n: remaining })}</span>
          </button>
          <button className="tool" onClick={() => onOpen("assistant")} data-testid="open-assistant">
            <span className="tool-icon">🤖</span>
            <strong>{t("home.quick.assistant")}</strong>
            <span className="hint">{t("home.quick.assistant_desc")}</span>
          </button>
          <button className="tool" onClick={() => onOpen("valuation")} data-testid="open-valuation">
            <span className="tool-icon">💰</span>
            <strong>{t("home.quick.valuation")}</strong>
            <span className="hint">{t("home.quick.valuation_desc")}</span>
          </button>
          <button className="tool" onClick={() => onOpen("favorites")} data-testid="open-favorites">
            <span className="tool-icon">❤️</span>
            <strong>{t("home.quick.favorites")}</strong>
            <span className="hint">{t("home.quick.favorites_desc")}</span>
          </button>
        </div>
      </section>

      {recent.length > 0 && (
        <section className="section" data-testid="recently-viewed">
          <h2>{t("home.recent")}</h2>
          {rail(recent)}
        </section>
      )}

      <section className="section">
        <div className="section-head">
          <h2>{t("home.fresh")}</h2>
          <button className="link" onClick={() => onCatalog({})} data-testid="open-catalog">
            {t("home.see_all")} ›
          </button>
        </div>
        {fresh === null ? (
          <div className="mini-grid">
            {Array.from({ length: 4 }, (_, i) => (
              <MiniCardSkeleton key={i} />
            ))}
          </div>
        ) : fresh.length ? (
          <div className="mini-grid">
            {fresh.map((i) => (
              <MiniCard key={i.listing.id} item={i} onOpen={() => onListing(i.listing.id)} />
            ))}
          </div>
        ) : failed ? (
          <LoadError onRetry={() => (setFailed(false), setFresh(null), setAttempt((a) => a + 1))} />
        ) : (
          <p className="hint center">{t("home.fresh_empty")}</p>
        )}
      </section>

      <button
        className="sell-hero"
        onClick={() => {
          haptic("light");
          onOpen("sell");
        }}
        data-testid="open-sell"
      >
        <span className="spark" aria-hidden>
          ✦
        </span>
        <span>
          <strong>{t("home.sell_banner.title")}</strong>
          <span className="hint">{t("home.sell_banner.text")}</span>
        </span>
        <span className="sell-cta">
          {t("home.sell_banner.cta")} <Icon name="arrow" />
        </span>
      </button>

      {homeScreen && (
        <button
          className="link"
          onClick={() => {
            promptAddToHomeScreen();
            setHomeScreen(false);
          }}
        >
          📲 {t("home.add_to_home")}
        </button>
      )}
    </div>
  );
}
