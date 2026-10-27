import { formatUzs, listingTitle, type CatalogItem } from "@ishonch/shared/client";
import { photoUrl } from "../api";
import { useLang, useT } from "../i18n";
import { Icon } from "./Icon";
import { GradeChip } from "./Passport";

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

/** «Samsung · Odyssey G5»: what the seller named, when they named it (from the listing's attributes). */
export function BrandLine({ item }: { item: CatalogItem }) {
  const a = item.listing.attributes;
  if (!a.brand) return null;
  // The model often repeats the brand ("Samsung Galaxy…"): show it once.
  const model = a.model?.replace(new RegExp(`^${a.brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "");
  return (
    <span className="brand-line" data-testid="brand-line">
      <b>{a.brand}</b>
      {model ? ` · ${model}` : ""}
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
  /** «Versus»: the scales button adds the listing to the compare list (on = already there). */
  compared?: boolean;
  onCompare?: () => void;
}

/** Product card for the catalog grid: photo first, then the price, the title and the trust marks. */
export function ItemCard({ item, onOpen, onFavorite, selected, onSelect, compared, onCompare }: Props) {
  const t = useT();
  const lang = useLang();
  const l = item.listing;
  return (
    <article className="item-card" data-testid="item-card">
      <button className="item-main" onClick={onOpen}>
        <span className="item-photo">
          {l.photos[0] ? <img src={photoUrl(l.photos[0].url, 480)} alt="" loading="lazy" width={300} height={300} /> : <span className="no-photo">📦</span>}
          {l.grade && <GradeChip grade={l.grade} />}
          {l.verified && <span className="mini-badge">✅ {t("verified.short")}</span>}
        </span>
        <span className="item-body">
          <BrandLine item={item} />
          {l.price && (
            <span className="item-price">
              {formatUzs(l.price)}
              {l.previousPrice && <s className="old-price"> {formatUzs(l.previousPrice)}</s>}
            </span>
          )}
          <MarketBadge item={item} />
          <span className="item-title">{listingTitle(l, lang)}</span>
          <span className="hint">
            {l.district ? `${t(`district.${l.district}`)} · ` : ""}
            {l.condition ? t(`condition.${l.condition}`) : ""}
          </span>
          <TrustBadge item={item} />
        </span>
      </button>
      {(onFavorite || onSelect || onCompare) && (
        <div className="item-actions">
          {onFavorite && (
            <button
              className={item.favorite ? "icon-btn item-fav on" : "icon-btn item-fav"}
              aria-label={item.favorite ? t("listing.favorite_remove") : t("listing.favorite_add")}
              onClick={() => onFavorite(!item.favorite)}
            >
              <Icon name="heart" filled={item.favorite} />
            </button>
          )}
          {onCompare && (
            <button
              className={compared ? "icon-btn item-fav item-compare on" : "icon-btn item-fav item-compare"}
              aria-label={compared ? t("versus.remove") : t("versus.add")}
              aria-pressed={compared}
              onClick={onCompare}
              data-testid="item-compare"
            >
              <Icon name="compare" />
            </button>
          )}
          {onSelect && (
            <label className="item-check">
              <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} />
            </label>
          )}
        </div>
      )}
    </article>
  );
}
