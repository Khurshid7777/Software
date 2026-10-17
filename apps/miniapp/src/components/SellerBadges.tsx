import type { SellerBadge } from "@ishonch/shared/client";
import { useT } from "../i18n";

/** Earned seller badges (eBay Top Rated style): each one is a fact from Ishonch's own data, not a paid label. */
export function SellerBadges({ badges }: { badges: SellerBadge[] }) {
  const t = useT();
  if (!badges.length) return null;
  return (
    <div className="chips" data-testid="seller-badges">
      {badges.map((b) => (
        <span key={b} className="badge" data-testid={`seller-badge-${b}`}>
          {t(`badge.${b}`)}
        </span>
      ))}
    </div>
  );
}
