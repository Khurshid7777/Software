import { useCallback, useEffect, useState } from "react";
import { formatUzs, listingTitle, type OrderDto } from "@ishonch/shared";
import { ApiError, apiUrl, type Api } from "../api";
import { useLang, useT } from "../i18n";

interface Props {
  api: Api;
  /** Opened from a bot notification (startapp=order_<id>). */
  focusId?: string;
  onOpenListing: (id: string) => void;
}

export function Orders({ api, focusId, onOpenListing }: Props) {
  const t = useT();
  const [role, setRole] = useState<"buyer" | "seller">("buyer");
  const [items, setItems] = useState<OrderDto[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Notifications about sales open the seller tab.
  useEffect(() => {
    if (focusId) api.order(focusId).then((o) => o.role === "seller" && setRole("seller")).catch(() => undefined);
  }, [api, focusId]);

  const load = useCallback(() => {
    setItems(null);
    api.myOrders(role).then(setItems).catch(() => setItems([]));
  }, [api, role]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) setToast(ok);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    }
  }

  return (
    <div className="stack">
      <h1>{t("orders.title")}</h1>
      <div className="tabs" role="tablist">
        {(["buyer", "seller"] as const).map((r) => (
          <button key={r} role="tab" className={role === r ? "active" : ""} onClick={() => setRole(r)}>
            {t(`orders.tab.${r}`)}
          </button>
        ))}
      </div>
      {toast && (
        <p className="toast" onClick={() => setToast(null)}>
          {toast}
        </p>
      )}
      {items === null && <p className="hint center">{t("common.loading")}</p>}
      {items?.length === 0 && <p className="hint center">{t("orders.empty")}</p>}
      {items?.map((o) => (
        <OrderCard
          key={o.id}
          order={o}
          highlighted={o.id === focusId}
          onOpenListing={() => onOpenListing(o.listing.id)}
          onAction={(a) => act(() => api.orderAction(o.id, a))}
          onReview={(rating, text) => act(() => api.review(o.id, rating, text), t("orders.review_thanks"))}
        />
      ))}
    </div>
  );
}

function OrderCard({
  order: o,
  highlighted,
  onOpenListing,
  onAction,
  onReview,
}: {
  order: OrderDto;
  highlighted: boolean;
  onOpenListing: () => void;
  onAction: (a: "confirm" | "decline" | "cancel") => void;
  onReview: (rating: number, text: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const date = (iso: string) =>
    new Date(iso).toLocaleString(lang === "ru" ? "ru-RU" : "uz-UZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const q = o.quote;

  return (
    <article className={`card stack${highlighted ? " highlighted" : ""}`} data-testid="order-card">
      <button className="listing-main" onClick={onOpenListing}>
        {o.listing.photoUrl ? <img src={apiUrl(o.listing.photoUrl)} alt="" /> : <div className="no-photo">📦</div>}
        <span>
          <strong>{listingTitle(o.listing, lang) || "—"}</strong>
          <span className={`badge order-${o.status}`}>{t(`order.status.${o.status}`)}</span>
          <span className="hint">
            {t(`delivery.${o.mode}`)} · 📍 {t(`district.${o.district}`)}
          </span>
        </span>
      </button>

      {o.address && <p className="hint">{t("orders.address", { address: o.address })}</p>}
      {o.courier?.name && <p className="hint">{t("order.courier", { name: o.courier.name })}</p>}
      <p>
        {o.role === "seller"
          ? t("orders.seller_receives", { sum: formatUzs(q.sellerReceives) })
          : t("orders.buyer_pays", { sum: formatUzs(o.mode === "delivery_only" ? q.buyerFee : q.buyerTotal) })}
      </p>
      {o.status === "cancelled" && o.cancelReason && (
        <p className="hint">{t(`order.cancel_reason.${o.cancelReason}` as "order.cancel_reason.banned")}</p>
      )}

      <details>
        <summary className="hint">{date(o.createdAt)}</summary>
        <ol className="history">
          {o.history.map((h, i) => (
            <li key={i}>
              {date(h.at)} — {t(`order.status.${h.status}`)}
            </li>
          ))}
        </ol>
      </details>

      {o.actions.length > 0 && !o.actions.includes("review") && (
        <div className="row wrap">
          {o.actions.includes("confirm") && (
            <button className="chip" onClick={() => onAction("confirm")} data-testid="order-confirm">
              ✅ {t("orders.confirm")}
            </button>
          )}
          {o.actions.includes("decline") && (
            <button className="chip" onClick={() => onAction("decline")}>
              ✖️ {t("orders.decline")}
            </button>
          )}
          {o.actions.includes("cancel") && (
            <button className="chip" onClick={() => window.confirm(t("orders.cancel") + "?") && onAction(o.role === "seller" ? "decline" : "cancel")}>
              ✖️ {t("orders.cancel")}
            </button>
          )}
        </div>
      )}

      {o.canReview && (
        <div className="stack" data-testid="review-form">
          <strong>{t("orders.review_title")}</strong>
          <div className="row stars" role="radiogroup">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={n <= rating ? "star active" : "star"} aria-label={`${n}`} onClick={() => setRating(n)}>
                ★
              </button>
            ))}
          </div>
          <textarea rows={2} maxLength={500} value={text} placeholder={t("orders.review_placeholder")} onChange={(e) => setText(e.target.value)} />
          <button className="primary" disabled={rating === 0} onClick={() => onReview(rating, text)} data-testid="review-send">
            {t("orders.review_send")}
          </button>
        </div>
      )}
      {o.review && <p className="hint">{t("orders.your_review", { stars: "⭐".repeat(o.review.rating) })}</p>}
    </article>
  );
}
