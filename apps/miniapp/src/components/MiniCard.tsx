import { formatUzs, listingTitle, type CatalogItem } from "@ishonch/shared/client";
import { photoUrl } from "../api";
import { useLang, useT } from "../i18n";
import { BrandLine, MarketBadge } from "./ItemCard";
import { GradeChip } from "./Passport";

/** Compact two-column card for the storefront: photo first, then price and title. */
/** `note`: a short comparison with the listing the buyer is looking at («дешевле на 12%», «класс выше»). */
export function MiniCard({ item, onOpen, note }: { item: CatalogItem; onOpen: () => void; note?: string | null }) {
  const t = useT();
  const lang = useLang();
  const l = item.listing;
  return (
    <button className="mini-card" onClick={onOpen} data-testid="mini-card">
      <span className="mini-photo">
        {l.photos[0] ? <img src={photoUrl(l.photos[0].url, 480)} alt="" loading="lazy" width={300} height={300} /> : <span className="no-photo">📦</span>}
        {l.verified && <span className="mini-badge">✅ {t("verified.short")}</span>}
        {l.grade && (
          <span className="mini-grade">
            <GradeChip grade={l.grade} />
          </span>
        )}
      </span>
      <span className="mini-body">
        <BrandLine item={item} />
        {l.price && (
          <strong className="mini-price">
            {formatUzs(l.price)}
            {l.previousPrice && <s className="old-price"> {formatUzs(l.previousPrice)}</s>}
          </strong>
        )}
        {note ? <span className="mini-note">{note}</span> : <MarketBadge item={item} />}
        <span className="mini-title">{listingTitle(l, lang)}</span>
        {l.district && <span className="hint">{t(`district.${l.district}`)}</span>}
      </span>
    </button>
  );
}

export function MiniCardSkeleton() {
  return (
    <span className="mini-card skeleton" aria-hidden>
      <span className="mini-photo" />
      <span className="mini-body">
        <span className="sk-line" />
        <span className="sk-line short" />
      </span>
    </span>
  );
}
