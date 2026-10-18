import type { BundleDiscount, SellerBadge } from "@ishonch/shared/client";
import { useT } from "../i18n";

/** The shop's set discount, shown where the buyer decides (listing, seller page). */
export function BundleBadge({ discount: d }: { discount: BundleDiscount | null | undefined }) {
  const t = useT();
  if (!d || (!d.two && !d.three)) return null;
  return (
    <p className="hint-card" data-testid="bundle-badge">
      {!d.two
        ? t("bundle.badge_three", { three: d.three })
        : d.three > d.two
          ? t("bundle.badge", { two: d.two, three: d.three })
          : t("bundle.badge_two", { two: d.two })}
    </p>
  );
}

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
