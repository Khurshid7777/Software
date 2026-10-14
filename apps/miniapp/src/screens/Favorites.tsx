import { useEffect, useState } from "react";
import type { CatalogItem } from "@ishonch/shared/client";
import type { Api, SavedSearch } from "../api";
import { ItemCard } from "../components/ItemCard";
import { useT } from "../i18n";

export function Favorites({ api, onOpen, onSearch }: { api: Api; onOpen: (id: string) => void; onSearch: (s: SavedSearch) => void }) {
  const t = useT();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [searches, setSearches] = useState<SavedSearch[]>([]);

  useEffect(() => {
    api.favorites().then(setItems).catch(() => setItems([]));
    api.searches().then(setSearches).catch(() => undefined);
  }, [api]);

  return (
    <div className="stack">
      <h1>{t("favorites.title")}</h1>
      {items === null && <p className="hint center">{t("common.loading")}</p>}
      {items?.length === 0 && <p className="hint center">{t("favorites.empty")}</p>}
      {items?.map((i) => (
        <ItemCard
          key={i.listing.id}
          item={i}
          onOpen={() => onOpen(i.listing.id)}
          onFavorite={async (on) => {
            await api.setFavorite(i.listing.id, on);
            setItems((list) => list?.filter((x) => x.listing.id !== i.listing.id) ?? null);
          }}
        />
      ))}

      <h2>🔔 {t("searches.title")}</h2>
      {searches.length === 0 && <p className="hint">{t("searches.empty")}</p>}
      {searches.map((s) => (
        <div key={s.id} className="card row between">
          <button className="link" onClick={() => onSearch(s)}>
            {s.title}
          </button>
          <button
            className="link danger"
            onClick={async () => {
              await api.deleteSearch(s.id);
              setSearches(searches.filter((x) => x.id !== s.id));
            }}
          >
            {t("searches.delete")}
          </button>
        </div>
      ))}
    </div>
  );
}
