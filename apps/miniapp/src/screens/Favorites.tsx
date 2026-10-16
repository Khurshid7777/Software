import { useEffect, useRef, useState } from "react";
import { useOnShow } from "../leave";
import type { CatalogItem } from "@ishonch/shared/client";
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
}

export function Favorites({ api, visible = true, onOpen, onSearch, onCatalog }: Props) {
  const t = useT();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [searches, setSearches] = useState<SavedSearch[]>([]);
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
        <div key={s.id} className="card row between">
          <button className="link" onClick={() => onSearch(s)}>
            {s.title}
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
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
