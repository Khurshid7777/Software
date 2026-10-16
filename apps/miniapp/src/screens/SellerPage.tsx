import { useEffect, useState } from "react";
import type { CatalogItem, ListingSeller, ReviewDto, TrustLevel } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { Empty } from "../components/Empty";
import { LoadError } from "../components/LoadError";
import { MiniCard, MiniCardSkeleton } from "../components/MiniCard";
import { useLang, useT } from "../i18n";

/** Public page of a seller: who they are on Ishonch (trust facts) and everything they sell now. */
export function SellerPage({ api, sellerId, onOpen }: { api: Api; sellerId: string; onOpen: (id: string) => void }) {
  const t = useT();
  const lang = useLang();
  const [data, setData] = useState<{ seller: ListingSeller; trust: TrustLevel; items: CatalogItem[] } | null>(null);
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
