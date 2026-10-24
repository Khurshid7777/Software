import { useCallback, useEffect, useRef, useState } from "react";
import {
  CATALOG_SORTS,
  CHECK_CATEGORIES,
  CONDITIONS,
  TASHKENT_DISTRICTS,
  type CatalogFilters,
  type CatalogItem,
  type CatalogSort,
} from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { ItemCard } from "../components/ItemCard";
import { LoadError } from "../components/LoadError";
import { BuyerPromise } from "../components/Promise";
import { toggleCompare, useCompare } from "../compare";
import { Toast } from "../components/Toast";
import { digitsOnly, groupDigits } from "../prefs";
import { haptic } from "../telegram";
import { useT } from "../i18n";

interface Props {
  api: Api;
  initial?: CatalogFilters;
  onOpen: (id: string) => void;
  onFiltersChange?: (f: CatalogFilters) => void;
  /** «Как проходит проверка» from the promise strip under the search. */
  onHow?: () => void;
}

export function Catalog({ api, initial, onOpen, onFiltersChange, onHow }: Props) {
  const t = useT();
  const compareIds = useCompare();
  const [filters, setFilters] = useState<CatalogFilters>(initial ?? {});
  const [draft, setDraft] = useState<CatalogFilters>(initial ?? {});
  const [query, setQuery] = useState(initial?.q ?? "");
  const [sort, setSort] = useState<CatalogSort>("relevance");
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Only the latest request may update the list: a slow page for old filters must not land on new results.
  const seq = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(
    async (offset = 0) => {
      const id = ++seq.current;
      if (offset === 0) {
        setItems(null);
        setFailed(false);
      } else setLoadingMore(true);
      const page = await api.catalog(filters, sort, offset).catch(() => null);
      if (id !== seq.current) return;
      setLoadingMore(false);
      if (!page) {
        if (offset === 0) {
          setItems([]);
          setFailed(true);
        } else setToast(t("common.load_error"));
        return;
      }
      setItems((prev) => (offset === 0 ? page.items : [...(prev ?? []), ...page.items.filter((i) => !prev?.some((p) => p.listing.id === i.listing.id))]));
      setNext(page.nextOffset);
    },
    [api, filters, sort],
  );
  useEffect(() => void load(0), [load]);
  // Remembered in the navigation stack: coming back from a listing restores the same search.
  useEffect(() => onFiltersChange?.(filters), [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced text search.
  useEffect(() => {
    const id = setTimeout(() => setFilters((f) => (f.q === (query || undefined) ? f : { ...f, q: query || undefined })), 400);
    return () => clearTimeout(id);
  }, [query]);

  // Optimistic heart: flips at once, flips back if the request failed.
  async function favorite(item: CatalogItem, on: boolean) {
    const set = (v: boolean) => setItems((list) => list?.map((i) => (i.listing.id === item.listing.id ? { ...i, favorite: v } : i)) ?? null);
    set(on);
    haptic("light");
    try {
      await api.setFavorite(item.listing.id, on);
    } catch (e) {
      set(!on);
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    }
  }

  async function saveSearch() {
    try {
      await api.saveSearch(filters);
      setToast(t("catalog.search_saved"));
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    }
  }

  const activeFilters = Object.entries(filters).filter(([k, v]) => k !== "q" && v !== undefined && v !== false).length;

  function compare(item: CatalogItem) {
    if (toggleCompare(item.listing.id)) haptic("light");
    else setToast(t("versus.full", { n: compareIds.length }));
  }

  return (
    <div className="stack">
      <div className="catalog-head">
        <h1>{t("catalog.title")}</h1>
        <div className="row">
          <label className="search-box inset">
            <Icon name="search" />
            <input
              type="search"
              placeholder={t("catalog.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="catalog-search"
            />
          </label>
          <button
            className={activeFilters ? "chip active" : "chip"}
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
            data-testid="catalog-filters"
          >
            {t("catalog.filters")}
            {activeFilters ? ` · ${activeFilters}` : ""}
          </button>
        </div>
        <BuyerPromise variant="strip" onOpen={onHow} />
      </div>

      <div className="chips scroll-x bleed">
        <button className={`chip ${!filters.category ? "active" : ""}`} onClick={() => setFilters({ ...filters, category: undefined })}>
          {t("catalog.all_categories")}
        </button>
        {CHECK_CATEGORIES.filter((c) => c !== "other").map((c) => (
          <button key={c} className={`chip ${filters.category === c ? "active" : ""}`} onClick={() => setFilters({ ...filters, category: c })}>
            {t(`category.${c}`)}
          </button>
        ))}
      </div>

      {showFilters && (
        <div className="card stack" data-testid="filters-panel">
          <div className="row">
            <input
              inputMode="numeric"
              placeholder={t("catalog.price_from")}
              value={draft.priceMin ? groupDigits(String(draft.priceMin)) : ""}
              onChange={(e) => setDraft({ ...draft, priceMin: Number(digitsOnly(e.target.value)) || undefined })}
            />
            <input
              inputMode="numeric"
              placeholder={t("catalog.price_to")}
              value={draft.priceMax ? groupDigits(String(draft.priceMax)) : ""}
              onChange={(e) => setDraft({ ...draft, priceMax: Number(digitsOnly(e.target.value)) || undefined })}
            />
          </div>
          <div className="chips">
            {CONDITIONS.map((c) => {
              const on = draft.conditions?.includes(c) ?? false;
              return (
                <button
                  key={c}
                  className={`chip ${on ? "active" : ""}`}
                  onClick={() => {
                    const cur = draft.conditions ?? [];
                    const nextC = on ? cur.filter((x) => x !== c) : [...cur, c];
                    setDraft({ ...draft, conditions: nextC.length ? nextC : undefined });
                  }}
                >
                  {t(`condition.${c}`)}
                </button>
              );
            })}
          </div>
          <select value={draft.district ?? ""} onChange={(e) => setDraft({ ...draft, district: (e.target.value || undefined) as CatalogFilters["district"] })}>
            <option value="">{t("catalog.any_district")}</option>
            {TASHKENT_DISTRICTS.map((d) => (
              <option key={d} value={d}>
                {t(`district.${d}`)}
              </option>
            ))}
          </select>
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!draft.verifiedOnly}
              onChange={(e) => setDraft({ ...draft, verifiedOnly: e.target.checked || undefined })}
              data-testid="verified-only"
            />
            ✔️ {t("catalog.verified_only")}
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!draft.goodGrade}
              onChange={(e) => setDraft({ ...draft, goodGrade: e.target.checked || undefined })}
              data-testid="good-grade"
            />
            🅰️ {t("catalog.good_grade")}
          </label>
          <div className="row">
            <button
              className="secondary"
              onClick={() => {
                setDraft({ q: filters.q });
                setFilters({ q: filters.q });
              }}
            >
              {t("catalog.reset")}
            </button>
            <button
              className="primary"
              data-testid="apply-filters"
              onClick={() => {
                setFilters({ ...draft, q: filters.q, category: filters.category });
                setShowFilters(false);
              }}
            >
              {t("catalog.apply")}
            </button>
          </div>
        </div>
      )}

      {/* Sorting is visible and applies at once (it used to hide inside the filters panel). */}
      <div className="row between">
        <span className="hint">{items && items.length > 0 ? t("catalog.found", { n: items.length + (next !== null ? "+" : "") }) : ""}</span>
        <select className="sort-select" aria-label={t("catalog.sort_label")} value={sort} onChange={(e) => setSort(e.target.value as CatalogSort)}>
          {CATALOG_SORTS.map((s) => (
            <option key={s} value={s}>
              {t(`catalog.sort.${s}`)}
            </option>
          ))}
        </select>
      </div>

      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
      {items === null && (
        <div className="catalog-grid" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="item-skeleton">
              <span className="sk-photo" />
              <span className="sk-text">
                <span className="sk-line" />
                <span className="sk-line short" />
                <span className="sk-line short" />
              </span>
            </div>
          ))}
        </div>
      )}
      {failed && <LoadError onRetry={() => void load(0)} />}
      {items?.length === 0 && !failed && <Empty icon="🔍" title={t("catalog.nothing")} text={t("catalog.empty")} />}
      {!!items?.length && (
        <div className="catalog-grid">
          {items.map((i) => (
            <ItemCard
              key={i.listing.id}
              item={i}
              onOpen={() => onOpen(i.listing.id)}
              onFavorite={(on) => favorite(i, on)}
              compared={compareIds.includes(i.listing.id)}
              onCompare={() => compare(i)}
            />
          ))}
        </div>
      )}
      {next !== null && (
        <button className="secondary" disabled={loadingMore} onClick={() => load(next)}>
          {t("catalog.load_more")}
        </button>
      )}
      {/* A subscription makes sense for a concrete search, not for "everything". */}
      {(filters.q || activeFilters > 0 || filters.category) && (
        <button className="secondary" onClick={saveSearch} data-testid="save-search">
          {t("catalog.save_search")}
        </button>
      )}
    </div>
  );
}
