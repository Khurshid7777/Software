import { useEffect, useState } from "react";
import { CHECK_CATEGORIES, type CatalogFilters, type CatalogItem } from "@ishonch/shared/client";
import type { Api } from "../api";
import { MiniCard, MiniCardSkeleton } from "../components/MiniCard";
import { useT } from "../i18n";
import { readRecent } from "../prefs";
import { canAddToHomeScreen, haptic, promptAddToHomeScreen } from "../telegram";

/** Category chips on the storefront (the catch-all ones live in the catalog filters). */
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

interface Props {
  api: Api;
  /** Staff see an entry to the admin panel (operators: delivery orders only). */
  staff?: "admin" | "operator" | null;
  remaining: number;
  onOpen: (screen: "check" | "sell" | "assistant" | "favorites" | "admin") => void;
  onCatalog: (filters?: CatalogFilters) => void;
  onListing: (id: string) => void;
}

/**
 * Storefront: search, categories, fresh listings and the three "Ishonch" tools (Tekshir, AI assistant,
 * favorites). Everything personal lives in the Profile tab.
 */
export function Home({ api, staff, remaining, onOpen, onCatalog, onListing }: Props) {
  const t = useT();
  const [fresh, setFresh] = useState<CatalogItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [homeScreen, setHomeScreen] = useState(false);
  const [recent, setRecent] = useState<CatalogItem[]>([]);

  useEffect(() => {
    let current = true;
    api
      .catalog({}, "newest", 0)
      .then((p) => current && setFresh(p.items.slice(0, 6)))
      .catch(() => current && (setFresh([]), setFailed(true)));
    canAddToHomeScreen().then((v) => current && setHomeScreen(v));
    api
      .catalogBatch(readRecent())
      .then((items) => current && setRecent(items))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [api]);

  return (
    <div className="stack" data-testid="home">
      <header className="stack-tight">
        <h1>{t("app.name")}</h1>
        <p className="hint">{t("app.tagline")}</p>
      </header>

      <form
        className="search-box"
        onSubmit={(e) => {
          e.preventDefault();
          onCatalog(query.trim() ? { q: query.trim() } : undefined);
        }}
      >
        <span aria-hidden>🔍</span>
        <input
          type="search"
          enterKeyHint="search"
          placeholder={t("catalog.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="home-search"
        />
      </form>

      <div className="category-strip scroll-x" role="list">
        {CATEGORIES.map((c) => (
          <button key={c} role="listitem" className="category" onClick={() => onCatalog({ category: c })}>
            <span className="category-icon" aria-hidden>
              {CATEGORY_ICONS[c]}
            </span>
            <span>{t(`category.${c}`)}</span>
          </button>
        ))}
      </div>

      {staff && (
        <button className="tile" onClick={() => onOpen("admin")} data-testid="open-admin">
          <span className="tile-icon">🛠</span>
          <span>
            <strong>{staff === "admin" ? "Админка" : "Заказы на доставку"}</strong>
            <span className="hint">{staff === "admin" ? "Метрики, модерация, заказы, пользователи" : "Курьеры и статусы"}</span>
          </span>
        </button>
      )}

      <div className="quick-actions">
        <button className="quick primary-quick" onClick={() => onOpen("check")} data-testid="open-check">
          <span className="quick-icon">🔎</span>
          <strong>Tekshir</strong>
          <span className="hint">{t("home.quick.check", { n: remaining })}</span>
        </button>
        <button className="quick" onClick={() => onOpen("assistant")} data-testid="open-assistant">
          <span className="quick-icon">🤖</span>
          <strong>{t("home.quick.assistant")}</strong>
          <span className="hint">{t("home.quick.assistant_desc")}</span>
        </button>
        <button className="quick" onClick={() => onOpen("favorites")} data-testid="open-favorites">
          <span className="quick-icon">❤️</span>
          <strong>{t("home.quick.favorites")}</strong>
          <span className="hint">{t("home.quick.favorites_desc")}</span>
        </button>
      </div>

      {recent.length > 0 && (
        <section className="stack-tight" data-testid="recently-viewed">
          <h2>{t("home.recent")}</h2>
          <div className="recent-strip scroll-x">
            {recent.map((i) => (
              <div key={i.listing.id} className="recent-item">
                <MiniCard item={i} onOpen={() => onListing(i.listing.id)} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="stack-tight">
        <div className="row between">
          <h2>{t("home.fresh")}</h2>
          <button className="link" onClick={() => onCatalog({})} data-testid="open-catalog">
            {t("home.see_all")} →
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
        ) : (
          <p className="hint center">{failed ? t("common.error") : t("home.fresh_empty")}</p>
        )}
      </section>

      <button
        className="sell-banner"
        onClick={() => {
          haptic("light");
          onOpen("sell");
        }}
        data-testid="open-sell"
      >
        <span className="tile-icon">📸</span>
        <span>
          <strong>{t("home.sell_banner.title")}</strong>
          <span className="hint">{t("home.sell_banner.text")}</span>
        </span>
        <span aria-hidden>→</span>
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
