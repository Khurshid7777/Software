import { useCallback, useEffect, useRef, useState } from "react";
import { formatUzs, listingTitle, type OrderDto } from "@ishonch/shared/client";
import { photoUrl, ApiError, type Api } from "../api";
import { Empty } from "../components/Empty";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useLang, useT } from "../i18n";
import { confirmDialog } from "../dialogs";
import { useLatest } from "../useLatest";
import { useOnShow } from "../leave";

interface Props {
  api: Api;
  /** Top of the navigation stack: lists refresh when the user comes back (an edit, an order changed). */
  visible?: boolean;
  /** Opened from a bot notification (startapp=order_<id>). */
  focusId?: string;
  onOpenListing: (id: string) => void;
  onCatalog: () => void;
}

export function Orders({ api, visible = true, focusId, onOpenListing, onCatalog }: Props) {
  const t = useT();
  // A notification link: the order's side (buyer/seller) is resolved before the first load (no flash).
  const [role, setRole] = useState<"buyer" | "seller" | null>(focusId ? null : "buyer");
  const [items, setItems] = useState<OrderDto[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // Notifications about sales open the seller tab.
  useEffect(() => {
    if (focusId)
      api
        .order(focusId)
        .then((o) => setRole(o.role === "seller" ? "seller" : "buyer"))
        .catch(() => setRole("buyer"));
  }, [api, focusId]);

  const begin = useLatest();
  const load = useCallback(() => {
    if (!role) return;
    const isCurrent = begin();
    setItems(null);
    setFailed(false);
    api
      .myOrders(role)
      .then((list) => isCurrent() && setItems(list))
      .catch(() => isCurrent() && (setItems([]), setFailed(true)));
  }, [api, role, begin]);
  useEffect(load, [load]);
  // Bring the order from the notification into view once the list is there.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!focusId || !items || scrolled.current) return;
    scrolled.current = true;
    document.getElementById(`order-${focusId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [items, focusId]);
  const shown = useRef(false);
  useOnShow(visible, () => (shown.current ? load() : (shown.current = true)));

  const [busy, setBusy] = useState(false);
  async function act(fn: () => Promise<unknown>, ok?: string) {
    if (busy) return; // one action at a time: no double confirm / double review
    setBusy(true);
    try {
      await fn();
      if (ok) setToast(ok);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
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
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
      {items === null && <p className="hint center">{t("common.loading")}</p>}
      {failed && <LoadError onRetry={load} />}
      {items?.length === 0 && !failed && (
        <Empty
          icon={role === "buyer" ? "🛍️" : "📦"}
          title={t("orders.empty")}
          text={t(role === "buyer" ? "orders.empty_buyer" : "orders.empty_seller")}
          action={
            role === "buyer" ? (
              <button className="primary" onClick={onCatalog}>
                {t("common.to_catalog")}
              </button>
            ) : undefined
          }
        />
      )}
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
    <article id={`order-${o.id}`} className={`card stack${highlighted ? " highlighted" : ""}`} data-testid="order-card">
      <button className="listing-main" onClick={onOpenListing}>
        {o.listing.photoUrl ? <img src={photoUrl(o.listing.photoUrl, 240)} alt="" loading="lazy" /> : <div className="no-photo">📦</div>}
        <span>
          <strong>{listingTitle(o.listing, lang) || "—"}</strong>
          <span className={`badge order-${o.status}`}>{t(`order.status.${o.status}`)}</span>
          <span className="hint">
            {t(`delivery.${o.mode}`)} · 📍 {t(`district.${o.district}`)}
          </span>
        </span>
      </button>

      {o.bundle.length > 0 && (
        <p className="hint" data-testid="order-bundle">
          🧺 {t("orders.bundle_with", { titles: o.bundle.map((b) => listingTitle(b, lang)).join(", ") })}
        </p>
      )}
      {o.inspection && (
        <p className="hint" data-testid="order-inspection">
          {o.inspection.passed ? `✅ ${t("verified.badge")}` : `⚠️ ${t("orders.inspection_issues")}`}
          {o.inspection.note && ` — ${o.inspection.note}`}
        </p>
      )}
      {o.address && <p className="hint">{t("orders.address", { address: o.address })}</p>}
      {o.courier?.name && <p className="hint">{t("order.courier", { name: o.courier.name })}</p>}
      <p>
        {o.role === "seller"
          ? t("orders.seller_receives", { sum: formatUzs(q.sellerReceives) })
          : t("orders.buyer_pays", { sum: formatUzs(o.mode === "delivery_only" ? q.buyerFee : q.buyerTotal) })}
      </p>
      {o.status === "cancelled" && o.cancelReason && (
        <p className="hint">{cancelReasonText(t, o.cancelReason)}</p>
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
            <button className="chip" onClick={async () => (await confirmDialog(t("orders.decline_confirm"))) && onAction("decline")}>
              ✖️ {t("orders.decline")}
            </button>
          )}
          {o.actions.includes("cancel") && (
            <button className="chip" onClick={async () => (await confirmDialog(t("orders.cancel_confirm"))) && onAction(o.role === "seller" ? "decline" : "cancel")}>
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

/** Known reasons are translated; an operator's free-text note is shown as is. */
function cancelReasonText(t: ReturnType<typeof useT>, reason: string) {
  const key = `order.cancel_reason.${reason}` as Parameters<typeof t>[0];
  const text = t(key);
  return text === key ? reason : text;
}
