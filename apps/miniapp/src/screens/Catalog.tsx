import { useCallback, useEffect, useRef, useState } from "react";
import {
  CATALOG_SORTS,
  CHECK_CATEGORIES,
  CONDITIONS,
  TASHKENT_DISTRICTS,
  type CatalogFilters,
  type CatalogItem,
  type CatalogSort,
} from "@ishonch/shared";
import { ApiError, type Api } from "../api";
import { ItemCard } from "../components/ItemCard";
import { useT } from "../i18n";

interface Props {
  api: Api;
  initial?: CatalogFilters;
  onOpen: (id: string) => void;
}

export function Catalog({ api, initial, onOpen }: Props) {
  const t = useT();
  const [filters, setFilters] = useState<CatalogFilters>(initial ?? {});
  const [draft, setDraft] = useState<CatalogFilters>(initial ?? {});
  const [query, setQuery] = useState(initial?.q ?? "");
  const [sort, setSort] = useState<CatalogSort>("relevance");
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Only the latest request may update the list: a slow page for old filters must not land on new results.
  const seq = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(
    async (offset = 0) => {
      const id = ++seq.current;
      if (offset === 0) setItems(null);
      else setLoadingMore(true);
      const page = await api.catalog(filters, sort, offset).catch(() => null);
      if (id !== seq.current) return;
      setLoadingMore(false);
      if (!page) {
        if (offset === 0) setItems([]);
        setToast(t("common.error"));
        return;
      }
      setItems((prev) => (offset === 0 ? page.items : [...(prev ?? []), ...page.items.filter((i) => !prev?.some((p) => p.listing.id === i.listing.id))]));
      setNext(page.nextOffset);
    },
    [api, filters, sort],
  );
  useEffect(() => void load(0), [load]);

  // Debounced text search.
  useEffect(() => {
    const id = setTimeout(() => setFilters((f) => (f.q === (query || undefined) ? f : { ...f, q: query || undefined })), 400);
    return () => clearTimeout(id);
  }, [query]);

  async function favorite(item: CatalogItem, on: boolean) {
    await api.setFavorite(item.listing.id, on).catch(() => undefined);
    setItems((list) => list?.map((i) => (i.listing.id === item.listing.id ? { ...i, favorite: on } : i)) ?? null);
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

  return (
    <div className="stack">
      <h1>{t("catalog.title")}</h1>
      <div className="row">
        <input
          className="search"
          type="search"
          placeholder={t("catalog.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="catalog-search"
        />
        <button className="chip" onClick={() => setShowFilters(!showFilters)} data-testid="catalog-filters">
          ⚙️ {activeFilters ? activeFilters : ""}
        </button>
      </div>

      <div className="chips scroll-x">
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
              value={draft.priceMin ?? ""}
              onChange={(e) => setDraft({ ...draft, priceMin: Number(e.target.value.replace(/\D/g, "")) || undefined })}
            />
            <input
              inputMode="numeric"
              placeholder={t("catalog.price_to")}
              value={draft.priceMax ?? ""}
              onChange={(e) => setDraft({ ...draft, priceMax: Number(e.target.value.replace(/\D/g, "")) || undefined })}
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
          <select value={sort} onChange={(e) => setSort(e.target.value as CatalogSort)}>
            {CATALOG_SORTS.map((s) => (
              <option key={s} value={s}>
                {t(`catalog.sort.${s}`)}
              </option>
            ))}
          </select>
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

      {toast && (
        <p className="toast" onClick={() => setToast(null)}>
          {toast}
        </p>
      )}
      {items === null && <p className="hint center">{t("common.loading")}</p>}
      {items?.length === 0 && <p className="hint center">{t("catalog.empty")}</p>}
      {items?.map((i) => (
        <ItemCard key={i.listing.id} item={i} onOpen={() => onOpen(i.listing.id)} onFavorite={(on) => favorite(i, on)} />
      ))}
      {next !== null && (
        <button className="secondary" disabled={loadingMore} onClick={() => load(next)}>
          {t("catalog.load_more")}
        </button>
      )}
      <button className="secondary" onClick={saveSearch} data-testid="save-search">
        {t("catalog.save_search")}
      </button>
    </div>
  );
}
