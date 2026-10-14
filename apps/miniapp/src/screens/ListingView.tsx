import { useEffect, useState } from "react";
import {
  COMPLAINT_REASONS,
  formatUzs,
  listingDescription,
  listingTitle,
  type CatalogItem,
  type ComplaintReason,
  type ListingDto,
} from "@ishonch/shared";
import { ApiError, apiUrl, type Api } from "../api";
import { MarketBadge, TrustBadge } from "../components/ItemCard";
import { useLang, useT } from "../i18n";
import { ensureWriteAccess } from "../telegram";

/** Public listing card (catalog, assistant, and the "Buy with delivery" button in seller channels). */
export function ListingView({ api, id, meId, onBuy }: { api: Api; id: string; meId: string; onBuy: (l: ListingDto) => void }) {
  const t = useT();
  const lang = useLang();
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [complaint, setComplaint] = useState<{ reason: ComplaintReason | null; text: string } | null>(null);

  useEffect(() => {
    api
      .catalogItem(id)
      .then(setItem)
      .catch((e) => setError(e instanceof ApiError ? e.message : t("listing.not_found")));
  }, [api, id]);

  if (error) return <p className="center hint">{error}</p>;
  if (!item) return <p className="center hint">{t("common.loading")}</p>;
  const l = item.listing;
  const own = l.seller?.id === meId;
  const date = (iso: string) => new Date(iso).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ");

  async function complain() {
    if (!complaint?.reason || sending) return;
    setSending(true);
    try {
      const res = await api.complain(l.id, complaint.reason, complaint.text);
      setToast(res.duplicate ? t("complaint.already") : t("complaint.sent"));
      setComplaint(null);
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setSending(false);
    }
  }

  async function send() {
    if (!message.trim() || sending) return;
    if (!(await ensureWriteAccess())) return setToast(t("listing.write_access"));
    setSending(true);
    try {
      await api.contact(l.id, message);
      setToast(t("listing.sent"));
      setWriting(false);
      setMessage("");
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="stack" data-testid="listing-view">
      {l.photos.length > 0 && (
        <div className="gallery">
          <img src={apiUrl(l.photos[photo]!.url)} alt="" />
          {l.photos.length > 1 && (
            <div className="dots">
              {l.photos.map((p, i) => (
                <button key={p.id} className={i === photo ? "active" : ""} onClick={() => setPhoto(i)} aria-label={`photo ${i + 1}`} />
              ))}
            </div>
          )}
        </div>
      )}
      <div className="row between">
        <h1>{listingTitle(l, lang)}</h1>
        {!own && (
          <button
            className="icon-btn"
            aria-label={item.favorite ? t("listing.favorite_remove") : t("listing.favorite_add")}
            onClick={async () => {
              await api.setFavorite(l.id, !item.favorite).catch(() => undefined);
              setItem({ ...item, favorite: !item.favorite });
            }}
          >
            {item.favorite ? "❤️" : "🤍"}
          </button>
        )}
      </div>
      {l.price && <p className="price">{formatUzs(l.price)}</p>}
      <MarketBadge item={item} />
      <p className="hint">
        {l.condition && t(`condition.${l.condition}`)}
        {l.district && ` · 📍 ${t(`district.${l.district}`)}`}
      </p>
      <p className="description">{listingDescription(l, lang)}</p>

      {l.seller && (
        <section className="card stack">
          <h3>{t("listing.seller")}</h3>
          <TrustBadge item={item} />
          <p className="hint" data-testid="seller-rating">
            {l.seller.rating.count > 0
              ? t("listing.rating", { avg: l.seller.rating.avg ?? "—", n: l.seller.rating.count })
              : t("listing.no_reviews")}
          </p>
          {l.seller.shop && (
            <p>
              🏪 {l.seller.shop.name} {l.seller.shop.verified && <span className="badge">{t("shop.verified")}</span>}
              {l.seller.shop.marketLocation && <span className="hint">{l.seller.shop.marketLocation}</span>}
            </p>
          )}
          <p className="hint">{t("listing.seller_since", { date: date(l.seller.registeredAt) })}</p>
          <p className="hint">{t("listing.sales", { n: l.seller.platformSales })}</p>
        </section>
      )}

      <section className="card">
        <h3>🚚 {t("listing.delivery_modes")}</h3>
        <ul>
          {l.allowedDeliveryModes.map((m) => (
            <li key={m}>{t(`delivery.${m}`)}</li>
          ))}
        </ul>
        <p className="hint">{t(`fee_payer.${l.feePayer}`)}</p>
      </section>

      {toast && (
        <p className="toast" onClick={() => setToast(null)}>
          {toast}
        </p>
      )}

      {l.status === "reserved" && <p className="hint-card center">{t("listing.reserved")}</p>}

      {own ? (
        <p className="hint center">{t("listing.own")}</p>
      ) : (
        l.status === "active" && (
          <>
            {writing ? (
              <div className="card stack">
                <textarea
                  rows={3}
                  placeholder={t("listing.write_placeholder")}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  data-testid="contact-text"
                />
                <p className="hint">{t("listing.contact_hint")}</p>
                <button className="primary" onClick={send} disabled={!message.trim() || sending} data-testid="contact-send">
                  {t("listing.send")}
                </button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setWriting(true)} data-testid="contact-open">
                💬 {t("listing.write")}
              </button>
            )}
            {l.allowedDeliveryModes.length > 0 && (
              <button className="primary" onClick={() => onBuy(l)} data-testid="buy-delivery">
                {t("listing.buy_delivery")}
              </button>
            )}
          </>
        )
      )}

      {!own && ["active", "reserved"].includes(l.status) && (
        complaint ? (
          <section className="card stack" data-testid="complaint-form">
            <h3>{t("complaint.title")}</h3>
            <div className="chips">
              {COMPLAINT_REASONS.map((r) => (
                <button key={r} className={complaint.reason === r ? "chip active" : "chip"} onClick={() => setComplaint({ ...complaint, reason: r })}>
                  {t(`complaint.reason.${r}`)}
                </button>
              ))}
            </div>
            <textarea
              rows={2}
              maxLength={500}
              placeholder={t("complaint.text_placeholder")}
              value={complaint.text}
              onChange={(e) => setComplaint({ ...complaint, text: e.target.value })}
            />
            <button className="secondary" disabled={!complaint.reason || sending} onClick={complain} data-testid="complaint-send">
              {t("complaint.send")}
            </button>
          </section>
        ) : (
          <button className="link danger" onClick={() => setComplaint({ reason: null, text: "" })} data-testid="complaint-open">
            ⚠️ {t("complaint.title")}
          </button>
        )
      )}
    </div>
  );
}
