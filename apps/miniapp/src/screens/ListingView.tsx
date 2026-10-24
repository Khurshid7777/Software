import { useEffect, useState } from "react";
import {
  COMPLAINT_REASONS,
  OFFER_PENDING_HOURS,
  formatUzs,
  isCargo,
  listingDescription,
  listingTitle,
  minOffer,
  type CatalogItem,
  type ComplaintReason,
  type ListingDto,
  type OfferDto,
  type ReviewDto,
} from "@ishonch/shared/client";
import { ApiError, apiUrl, type Api } from "../api";
import { Gallery } from "../components/Gallery";
import { Icon } from "../components/Icon";
import { MiniCard } from "../components/MiniCard";
import { digitsOnly, groupDigits, rememberViewed } from "../prefs";
import { ChecklistView } from "../components/Checklist";
import { MarketBadge, TrustBadge } from "../components/ItemCard";
import { Toast } from "../components/Toast";
import { TradeForm } from "../components/TradeForm";
import { LoadError } from "../components/LoadError";
import { MeetForm } from "../components/Meeting";
import { Passport } from "../components/Passport";
import { BundleBadge, SellerBadges } from "../components/SellerBadges";
import { useLang, useT } from "../i18n";
import { canShareStory, ensureWriteAccess, haptic, shareLink, shareToStory } from "../telegram";

/** Public listing card (catalog, assistant, and the "Buy with delivery" button in seller channels). */
interface Props {
  api: Api;
  id: string;
  meId: string;
  onBuy: (l: ListingDto) => void;
  onEdit?: (l: ListingDto) => void;
  onOpen?: (id: string) => void;
  onSeller?: (sellerId: string) => void;
}

export function ListingView({ api, id, meId, onBuy, onEdit, onOpen, onSeller }: Props) {
  const t = useT();
  const lang = useLang();
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [complaint, setComplaint] = useState<{ reason: ComplaintReason | null; text: string } | null>(null);
  const [offer, setOffer] = useState<OfferDto | null>(null);
  const [offering, setOffering] = useState<string | null>(null);
  const [trading, setTrading] = useState(false);
  const [meeting, setMeeting] = useState<"form" | "sent" | null>(null);
  const [reviews, setReviews] = useState<ReviewDto[] | null>(null);
  const [similar, setSimilar] = useState<CatalogItem[]>([]);

  useEffect(() => {
    setError(null);
    api
      .catalogItem(id)
      .then(setItem)
      .catch((e) => setError(e instanceof ApiError ? e.message : t("listing.not_found")));
    api
      .myOffer(id)
      .then((r) => setOffer(r.offer))
      .catch(() => undefined);
    api
      .similar(id)
      .then(setSimilar)
      .catch(() => undefined);
  }, [api, id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Recently viewed" on the storefront (own listings are not worth remembering).
  useEffect(() => {
    if (item && item.listing.seller?.id !== meId && item.listing.status === "active") rememberViewed(item.listing.id);
  }, [item, meId]);

  if (error) return <LoadError text={error} onRetry={() => setAttempt((a) => a + 1)} />;
  if (!item) return <p className="center hint">{t("common.loading")}</p>;
  const l = item.listing;
  const own = l.seller?.id === meId;
  // «В отъезде» (stage 28): the card still opens by link, but nothing can be ordered until the seller is back.
  const away = !own && l.seller?.awayUntil ? new Date(l.seller.awayUntil) : null;
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

  async function toggleReviews() {
    if (reviews) return setReviews(null);
    if (!l.seller) return;
    try {
      setReviews((await api.sellerReviews(l.seller.id)).reviews);
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    }
  }

  async function sendOffer() {
    const amount = Number((offering ?? "").replace(/\D/g, ""));
    if (!amount || sending) return;
    if (!(await ensureWriteAccess())) return setToast(t("listing.write_access"));
    setSending(true);
    try {
      setOffer(await api.makeOffer(l.id, amount));
      setOffering(null);
      setToast(t("offer.sent"));
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setSending(false);
    }
  }

  async function share(to: "chat" | "story") {
    try {
      const { url } = await api.shareLink(l.id);
      if (!url) return setToast(t("common.error"));
      const text = `${listingTitle(l, lang)}${l.price ? ` — ${formatUzs(l.price)}` : ""}`;
      if (to === "chat") return shareLink(url, text);
      const photo = l.photos[0];
      if (photo) shareToStory(new URL(apiUrl(photo.url), window.location.href).href, text, url, t("share.story_link"));
    } catch {
      setToast(t("common.error"));
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
    <div className={!own && !away && l.status === "active" && l.allowedDeliveryModes.length > 0 ? "stack with-action-bar" : "stack"} data-testid="listing-view">
      <Gallery photos={l.photos} />
      {l.video && (
        <section className="stack-tight" data-testid="listing-video">
          <strong>{t("listing.video")}</strong>
          <video className="video-check" src={apiUrl(l.video)} controls playsInline preload="metadata" />
        </section>
      )}
      <div className="lv-head">
      <div className="lv-title">
        <h1>{listingTitle(l, lang)}</h1>
        {!own && (
          <button
            className={item.favorite ? "icon-btn item-fav on" : "icon-btn item-fav"}
            aria-label={item.favorite ? t("listing.favorite_remove") : t("listing.favorite_add")}
            onClick={async () => {
              const on = !item.favorite;
              setItem({ ...item, favorite: on });
              haptic("light");
              try {
                await api.setFavorite(l.id, on);
                if (on) setToast(t("listing.favorite_added"));
              } catch (e) {
                setItem({ ...item, favorite: !on });
                setToast(e instanceof ApiError ? e.message : t("common.error"));
              }
            }}
          >
            <Icon name="heart" filled={item.favorite} />
          </button>
        )}
      </div>
      {l.price && (
        <p className="price">
          {formatUzs(l.price)}
          {l.previousPrice && (
            <>
              {" "}
              <s className="old-price" data-testid="old-price">{formatUzs(l.previousPrice)}</s>{" "}
              <span className="badge">📉 {t("listing.price_dropped")}</span>
            </>
          )}
          {l.acceptsTrade && (
            <>
              {" "}
              <span className="badge trade-badge" data-testid="trade-badge">
                {t("trade.badge")}
              </span>
            </>
          )}
        </p>
      )}
      <div className="lv-meta">
        <MarketBadge item={item} />
        <span className="hint">
          {l.condition && t(`condition.${l.condition}`)}
          {l.district && ` · 📍 ${t(`district.${l.district}`)}`}
        </span>
      </div>
      </div>
      {l.verified && (
        <p className="hint-card" data-testid="verified-badge">
          ✅ <strong>{t("verified.badge")}</strong> — {t("verified.desc", { date: date(l.verified.at) })}
        </p>
      )}
      {item.passport && <Passport passport={item.passport} />}
      <ChecklistView category={l.category} value={l.checklist} />
      {isCargo(l.category) && (
        <p className="hint-card" data-testid="listing-cargo">
          {t("listing.cargo")}
        </p>
      )}
      {l.imeiTail && <p className="hint-card" data-testid="imei-hint">🔐 {t("listing.imei", { tail: l.imeiTail })}</p>}
      <p className="description">{listingDescription(l, lang)}</p>
      {["active", "reserved"].includes(l.status) && (
        <div className="row wrap">
          <button className="chip" onClick={() => share("chat")} data-testid="share-chat">
            📤 {t("share.chat")}
          </button>
          {canShareStory() && l.photos.length > 0 && (
            <button className="chip" onClick={() => share("story")} data-testid="share-story">
              📸 {t("share.story")}
            </button>
          )}
        </div>
      )}

      {l.seller && (
        <section className="card stack">
          <h3>{t("listing.seller")}</h3>
          <TrustBadge item={item} />
          <SellerBadges badges={l.seller.badges} />
          <BundleBadge discount={l.seller.shop?.bundleDiscount} />
          {l.seller.rating.count > 0 ? (
            <button className="link" onClick={toggleReviews} data-testid="seller-rating">
              {t("listing.rating", { avg: l.seller.rating.avg ?? "—", n: l.seller.rating.count })} ·{" "}
              {reviews ? t("listing.reviews_hide") : t("listing.reviews_show")}
            </button>
          ) : (
            <p className="hint" data-testid="seller-rating">
              {t("listing.no_reviews")}
            </p>
          )}
          {reviews && (
            <div className="reviews" data-testid="seller-reviews">
              {reviews.map((r) => (
                <div key={r.id} className="review">
                  <span>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span> <span className="hint">{date(r.createdAt)}</span>
                  {r.text && <p>{r.text}</p>}
                </div>
              ))}
            </div>
          )}
          {l.seller.shop && (
            <p>
              🏪 {l.seller.shop.name} {l.seller.shop.verified && <span className="badge">{t("shop.verified")}</span>}
              {l.seller.shop.marketLocation && <span className="hint">{l.seller.shop.marketLocation}</span>}
            </p>
          )}
          <p className="hint">{t("listing.seller_since", { date: date(l.seller.registeredAt) })}</p>
          <p className="hint">{t("listing.sales", { n: l.seller.platformSales })}</p>
          {onSeller && !own && (
            <button className="link" onClick={() => onSeller(l.seller!.id)} data-testid="open-seller">
              {t("listing.seller_all")} →
            </button>
          )}
          {l.seller.inspections.passed > 0 && (
            <p className="hint">✅ {t("verified.seller", { n: l.seller.inspections.passed })}</p>
          )}
          {l.seller.responseMinutes != null && (
            <p className="hint" data-testid="response-time">
              ⚡️{" "}
              {l.seller.responseMinutes < 60
                ? t("listing.response_min", { n: l.seller.responseMinutes })
                : t("listing.response_hours", { n: Math.round(l.seller.responseMinutes / 60) })}
            </p>
          )}
        </section>
      )}

      {away && (
        <p className="hint-card" data-testid="seller-away">
          🏖 {t("away.banner", { date: away.toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ", { day: "numeric", month: "long" }) })}
        </p>
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

      {toast && <Toast text={toast} onClose={() => setToast(null)} />}

      {l.status === "reserved" && <p className="hint-card center">{t("listing.reserved")}</p>}

      {own ? (
        <>
          <p className="hint center">{t("listing.own")}</p>
          {onEdit && ["active", "pending", "rejected", "draft"].includes(l.status) && (
            <button className="secondary" onClick={() => onEdit(l)} data-testid="edit-own">
              ✏️ {t("listing.edit_own")}
            </button>
          )}
        </>
      ) : (
        l.status === "active" && (
          <>
            {writing ? (
              <div className="card stack">
                {!message && (
                  <div className="chips" data-testid="quick-questions">
                    {(["still_selling", "see_today", "bargain"] as const).map((q) => (
                      <button key={q} className="chip" onClick={() => setMessage(t(`listing.quick.${q}`))}>
                        {t(`listing.quick.${q}`)}
                      </button>
                    ))}
                  </div>
                )}
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
            {l.allowedDeliveryModes.length > 0 && !away && (
              // Always at hand: the main action does not scroll away with the description.
              <div className="action-bar">
                <div className="action-bar-inner">
                  {l.price && <span className="price-small">{formatUzs(l.price)}</span>}
                  <button className="primary" onClick={() => onBuy(l)} data-testid="buy-delivery">
                    {t("listing.buy_delivery")}
                  </button>
                </div>
              </div>
            )}
            {offer && (
              <p className={offer.status === "accepted" ? "hint-card center" : "hint center"} data-testid="offer-status">
                {offer.kind === "trade" && offer.trade
                  ? t(`trade.status.${offer.status}`, { item: offer.trade.title })
                  : t(`offer.status.${offer.status}`, {
                      amount: formatUzs(offer.amount),
                      until: new Date(offer.expiresAt).toLocaleString(lang === "ru" ? "ru-RU" : "uz-UZ", { dateStyle: "short", timeStyle: "short" }),
                    })}
              </p>
            )}
            {l.price && offer?.status !== "pending" && offer?.status !== "accepted" &&
              (offering === null ? (
                <button className="link" onClick={() => setOffering("")} data-testid="offer-open">
                  🏷️ {t("offer.make")}
                </button>
              ) : (
                <div className="card stack" data-testid="offer-form">
                  <input
                    inputMode="numeric"
                    placeholder={t("offer.amount_placeholder")}
                    value={groupDigits(offering)}
                    onChange={(e) => setOffering(digitsOnly(e.target.value))}
                    data-testid="offer-amount"
                  />
                  <p className="hint">{t("offer.hint", { min: formatUzs(minOffer(l.price)), hours: OFFER_PENDING_HOURS })}</p>
                  <button className="secondary" onClick={sendOffer} disabled={!offering || sending} data-testid="offer-send">
                    {t("offer.send")}
                  </button>
                </div>
              ))}
            {l.acceptsTrade && offer?.status !== "pending" && offer?.status !== "accepted" &&
              (trading ? (
                <TradeForm
                  api={api}
                  listingId={l.id}
                  onSent={(o) => {
                    setOffer(o);
                    setTrading(false);
                    setToast(t("trade.sent"));
                  }}
                  onError={setToast}
                />
              ) : (
                <button className="link" onClick={() => setTrading(true)} data-testid="trade-open">
                  {t("trade.open")}
                </button>
              ))}
            {l.status === "active" &&
              (meeting === "form" ? (
                <MeetForm
                  api={api}
                  listingId={l.id}
                  onSent={() => {
                    setMeeting("sent");
                    setToast(t("meet.sent"));
                  }}
                  onError={setToast}
                />
              ) : meeting === "sent" ? (
                <p className="hint-card center" data-testid="meet-sent">
                  {t("meet.sent")}
                </p>
              ) : (
                <button className="secondary" onClick={() => setMeeting("form")} data-testid="meet-open">
                  {t("meet.button")}
                </button>
              ))}
          </>
        )
      )}

      {similar.length > 0 && onOpen && (
        <section className="stack-tight" data-testid="similar">
          <h2>{t("listing.similar")}</h2>
          <div className="mini-grid">
            {similar.map((i) => (
              <MiniCard key={i.listing.id} item={i} onOpen={() => onOpen(i.listing.id)} />
            ))}
          </div>
        </section>
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
