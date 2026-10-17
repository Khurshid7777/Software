import { useEffect, useState } from "react";
import type { CatalogItem, ListingSeller, ReviewDto, TrustLevel } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { Empty } from "../components/Empty";
import { LoadError } from "../components/LoadError";
import { MiniCard, MiniCardSkeleton } from "../components/MiniCard";
import { useLang, useT } from "../i18n";
import { BundleBadge, SellerBadges } from "../components/SellerBadges";

/** Public page of a seller: who they are on Ishonch (trust facts) and everything they sell now. */
export function SellerPage({ api, sellerId, onOpen }: { api: Api; sellerId: string; onOpen: (id: string) => void }) {
  const t = useT();
  const lang = useLang();
  const [data, setData] = useState<{ seller: ListingSeller; trust: TrustLevel; items: CatalogItem[]; following: boolean } | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [reviews, setReviews] = useState<ReviewDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    api
      .sellerPage(sellerId)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : t("common.load_error")));
    api
      .sellerReviews(sellerId)
      .then((r) => setReviews(r.reviews))
      .catch(() => undefined);
  }, [api, sellerId, attempt]);

  if (error) return <LoadError text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  const date = (iso: string) => new Date(iso).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ");
  const s = data?.seller;

  return (
    <div className="stack" data-testid="seller-page">
      {!s ? (
        <div className="card stack">
          <span className="sk-line" />
          <span className="sk-line short" />
        </div>
      ) : (
        <section className="card stack">
          <div className="row between">
            <h1>{s.shop ? `🏪 ${s.shop.name}` : `👤 ${t("seller.private")}`}</h1>
            {s.shop?.verified && <span className="badge">✔️ {t("shop.verified")}</span>}
          </div>
          <span className={`trust trust-${data!.trust}`}>{t(`trust.${data!.trust}`)}</span>
          <SellerBadges badges={s.badges} />
          <div className="row between wrap">
            <button
              className={data!.following ? "secondary" : "primary"}
              disabled={followBusy}
              onClick={() => {
                setFollowBusy(true);
                api
                  .follow(s.id, !data!.following)
                  .then((r) => setData((d) => d && { ...d, following: r.following, seller: { ...d.seller, followers: r.followers } }))
                  .catch(() => undefined)
                  .finally(() => setFollowBusy(false));
              }}
              data-testid="follow-toggle"
            >
              {data!.following ? t("follow.following") : t("follow.button")}
            </button>
            <span className="hint" data-testid="followers">
              {t("follow.followers", { n: s.followers })}
            </span>
          </div>
          {!data!.following && <span className="hint">{t("follow.hint")}</span>}
          <BundleBadge discount={s.shop?.bundleDiscount} />
          {s.shop?.marketLocation && <span className="hint">📍 {s.shop.marketLocation}</span>}
          <div className="facts">
            <Fact value={s.rating.count ? `★ ${s.rating.avg}` : "—"} label={t("seller.reviews_n", { n: s.rating.count })} />
            <Fact value={String(s.platformSales)} label={t("seller.sales")} />
            <Fact value={String(s.inspections.passed)} label={t("seller.inspected")} />
            <Fact
              value={s.responseMinutes == null ? "—" : s.responseMinutes < 60 ? `${s.responseMinutes} ${t("seller.min")}` : `${Math.round(s.responseMinutes / 60)} ${t("seller.h")}`}
              label={t("seller.reply_time")}
            />
          </div>
          <span className="hint">{t("listing.seller_since", { date: date(s.registeredAt) })}</span>
        </section>
      )}

      <h2>{t("seller.listings")}</h2>
      {!data ? (
        <div className="mini-grid">
          {Array.from({ length: 4 }, (_, i) => (
            <MiniCardSkeleton key={i} />
          ))}
        </div>
      ) : data.items.length ? (
        <div className="mini-grid">
          {data.items.map((i) => (
            <MiniCard key={i.listing.id} item={i} onOpen={() => onOpen(i.listing.id)} />
          ))}
        </div>
      ) : (
        <Empty icon="📭" title={t("seller.no_listings")} />
      )}

      {reviews.length > 0 && (
        <section className="card stack" data-testid="seller-page-reviews">
          <h3>{t("seller.reviews_title")}</h3>
          <div className="reviews">
            {reviews.map((r) => (
              <div key={r.id} className="review">
                <span>
                  {"★".repeat(r.rating)}
                  {"☆".repeat(5 - r.rating)}
                </span>{" "}
                <span className="hint">{date(r.createdAt)}</span>
                {r.text && <p>{r.text}</p>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Fact({ value, label }: { value: string; label: string }) {
  return (
    <div className="fact">
      <strong>{value}</strong>
      <span className="hint">{label}</span>
    </div>
  );
}
