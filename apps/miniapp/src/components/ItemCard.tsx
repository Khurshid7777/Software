import { formatUzs, listingTitle, type CatalogItem } from "@ishonch/shared/client";
import { apiUrl } from "../api";
import { useLang, useT } from "../i18n";

export function MarketBadge({ item }: { item: CatalogItem }) {
  const t = useT();
  const m = item.market;
  if (!m || m.verdict === "unknown" || m.diffPct == null) return null;
  return (
    <span className={`market market-${m.verdict}`}>
      {t(`market.${m.verdict}`, { pct: Math.abs(m.diffPct) })}
      {m.approximate ? " ~" : ""}
    </span>
  );
}

export function TrustBadge({ item }: { item: CatalogItem }) {
  const t = useT();
  return (
    <span className={`trust trust-${item.trust}`}>
      {item.listing.seller?.shop?.verified ? "✔️ " : ""}
      {t(`trust.${item.trust}`)}
    </span>
  );
}

interface Props {
  item: CatalogItem;
  onOpen: () => void;
  onFavorite?: (on: boolean) => void;
  selected?: boolean;
  onSelect?: (on: boolean) => void;
}

export function ItemCard({ item, onOpen, onFavorite, selected, onSelect }: Props) {
  const t = useT();
  const lang = useLang();
  const l = item.listing;
  return (
    <article className="card item-card" data-testid="item-card">
      <button className="item-main" onClick={onOpen}>
        {l.photos[0] ? <img src={apiUrl(l.photos[0].url)} alt="" loading="lazy" /> : <div className="no-photo">📦</div>}
        <span className="item-body">
          <strong>{listingTitle(l, lang)}</strong>
          {l.price && (
            <span className="item-price">
              {formatUzs(l.price)}
              {l.previousPrice && <s className="old-price"> {formatUzs(l.previousPrice)}</s>}
            </span>
          )}
          <MarketBadge item={item} />
          <span className="hint">
            {l.district ? `📍 ${t(`district.${l.district}`)} · ` : ""}
            {l.condition ? t(`condition.${l.condition}`) : ""}
          </span>
          <TrustBadge item={item} />
        </span>
      </button>
      <div className="item-actions">
        {onFavorite && (
          <button
            className="icon-btn"
            aria-label={item.favorite ? t("listing.favorite_remove") : t("listing.favorite_add")}
            onClick={() => onFavorite(!item.favorite)}
          >
            {item.favorite ? "❤️" : "🤍"}
          </button>
        )}
        {onSelect && (
          <label className="check-row">
            <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} />
          </label>
        )}
      </div>
    </article>
  );
}
