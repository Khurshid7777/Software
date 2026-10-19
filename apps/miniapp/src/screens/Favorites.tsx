import { useEffect, useRef, useState } from "react";
import { useOnShow } from "../leave";
import { BELOW_MARKET_STEPS, type CatalogItem, type ListingSeller } from "@ishonch/shared/client";
import { ApiError, type Api, type SavedSearch } from "../api";
import { confirmDialog } from "../dialogs";
import { Empty } from "../components/Empty";
import { ItemCard } from "../components/ItemCard";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useT } from "../i18n";

interface Props {
  api: Api;
  visible?: boolean;
  onOpen: (id: string) => void;
  onSearch: (s: SavedSearch) => void;
  onCatalog: () => void;
  onSeller: (id: string) => void;
}

export function Favorites({ api, visible = true, onOpen, onSearch, onCatalog, onSeller }: Props) {
  const t = useT();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const [following, setFollowing] = useState<ListingSeller[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setFailed(false);
    setItems(null);
    api
      .favorites()
      .then(setItems)
      .catch(() => (setItems([]), setFailed(true)));
    api.searches().then(setSearches).catch(() => undefined);
    api.following().then(setFollowing).catch(() => undefined);
  }, [api, attempt]);

  // Coming back from a listing where the heart was switched off: refresh the list.
  const shown = useRef(false);
  useOnShow(visible, () => (shown.current ? setAttempt((a) => a + 1) : (shown.current = true)));

  const fail = (e: unknown) => setToast(e instanceof ApiError ? e.message : t("common.error"));

  return (
    <div className="stack">
      <h1>{t("favorites.title")}</h1>
      {items === null && <p className="hint center">{t("common.loading")}</p>}
      {failed && <LoadError onRetry={() => setAttempt((a) => a + 1)} />}
      {items?.length === 0 && !failed && (
        <Empty
          icon="🤍"
          title={t("favorites.empty_title")}
          text={t("favorites.empty")}
          action={
            <button className="primary" onClick={onCatalog}>
              {t("common.to_catalog")}
            </button>
          }
        />
      )}
      {items?.map((i) => (
        <ItemCard
          key={i.listing.id}
          item={i}
          onOpen={() => onOpen(i.listing.id)}
          onFavorite={(on) =>
            api
              .setFavorite(i.listing.id, on)
              .then(() => setItems((list) => list?.filter((x) => x.listing.id !== i.listing.id) ?? null))
              .catch(fail)
          }
        />
      ))}

      <h2>🔔 {t("searches.title")}</h2>
      {searches.length === 0 && <p className="hint">{t("searches.empty")}</p>}
      {searches.map((s) => (
        <div key={s.id} className="card row between" data-testid="saved-search">
          <button className="link" onClick={() => onSearch(s)}>
            {s.title}
          </button>
          <button
            className={s.public ? "chip active" : "chip"}
            aria-pressed={s.public}
            title={t("searches.public_hint")}
            onClick={() =>
              api
                .setSearchPublic(s.id, !s.public)
                .then((row) => setSearches((list) => list.map((x) => (x.id === s.id ? { ...x, public: row.public } : x))))
                .catch(fail)
            }
            data-testid="search-public"
          >
            🙋 {t(s.public ? "searches.public_on" : "searches.public_off")}
          </button>
          <button
            className={s.filters.belowMarketPct ? "chip active" : "chip"}
            title={t("searches.below_market_hint")}
            onClick={() => {
              // 10 → 15 → 20 → off.
              const steps: Array<number | null> = [...BELOW_MARKET_STEPS, null];
              const next = steps[(steps.indexOf(s.filters.belowMarketPct ?? null) + 1) % steps.length] ?? null;
              api
                .setSearchBelowMarket(s.id, next)
                .then((row) => setSearches((list) => list.map((x) => (x.id === s.id ? row : x))))
                .catch(fail);
            }}
            data-testid="search-below-market"
          >
            {s.filters.belowMarketPct ? t("searches.below_market_on", { pct: s.filters.belowMarketPct }) : t("searches.below_market_off")}
          </button>
          <button
            className="link danger"
            onClick={async () => {
              if (!(await confirmDialog(t("searches.delete_confirm")))) return;
              await api
                .deleteSearch(s.id)
                .then(() => setSearches((list) => list.filter((x) => x.id !== s.id)))
                .catch(fail);
            }}
          >
            {t("searches.delete")}
          </button>
        </div>
      ))}
      <h2>👥 {t("follow.list_title")}</h2>
      {following.length === 0 && <p className="hint">{t("follow.empty")}</p>}
      {following.map((s) => (
        <button key={s.id} className="card row between" onClick={() => onSeller(s.id)} data-testid="following-seller">
          <span>{s.shop ? `🏪 ${s.shop.name}` : `👤 ${t("seller.private")}`}</span>
          <span className="chevron" aria-hidden>
            ›
          </span>
        </button>
      ))}
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
