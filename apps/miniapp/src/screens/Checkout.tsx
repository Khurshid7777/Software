import { useEffect, useState } from "react";
import {
  TASHKENT_DISTRICTS,
  formatUzs,
  listingTitle,
  type DeliveryMode,
  type DeliveryQuote,
  type District,
  type ListingDto,
} from "@ishonch/shared";
import { ApiError, type Api } from "../api";
import { useLang, useT } from "../i18n";
import { askPhone, ensureWriteAccess } from "../telegram";

interface Props {
  api: Api;
  listing: ListingDto;
  onDone: (orderId: string) => void;
}

/** "Buy with delivery": mode, district and address → price breakdown → order request to the seller. */
export function Checkout({ api, listing, onDone }: Props) {
  const t = useT();
  const lang = useLang();
  const modes = listing.allowedDeliveryModes;
  const [mode, setMode] = useState<DeliveryMode>(modes.includes("cod_seller") ? "cod_seller" : modes[0]!);
  const [district, setDistrict] = useState<District | "">("");
  const [address, setAddress] = useState("");
  const [comment, setComment] = useState("");
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needPhone, setNeedPhone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!district) return;
    setQuote(null);
    api
      .quote(listing.id, district, mode)
      .then(setQuote)
      .catch((e) => setError(e instanceof ApiError ? e.message : t("common.error")));
  }, [api, listing.id, district, mode]);

  async function submit() {
    if (!district || address.trim().length < 5) return;
    setError(null);
    setBusy(true);
    try {
      // Status updates arrive from the bot; ask once so Telegram lets it write to the buyer.
      await ensureWriteAccess();
      const order = await api.createOrder({ listingId: listing.id, mode, district, address: address.trim(), comment: comment.trim() || undefined });
      onDone(order.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "phone_required") setNeedPhone(true);
      else setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function sharePhone() {
    if (!(await askPhone().catch(() => false))) return;
    // The contact reaches the API through the bot; wait for it, then retry.
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await api.me()).hasPhone) {
        setNeedPhone(false);
        return submit();
      }
    }
  }

  const sellerPart = quote && quote.sellerFee > 0;
  return (
    <div className="stack" data-testid="checkout">
      <h1>{t("checkout.title")}</h1>
      <p className="hint">{listingTitle(listing, lang)}</p>

      <section className="card stack">
        <h3>{t("checkout.mode")}</h3>
        {modes.map((m) => (
          <label key={m} className="check-row">
            <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
            {t(`delivery.${m}`)}
          </label>
        ))}
      </section>

      <label className="field">
        {t("checkout.district")}
        <select value={district} onChange={(e) => setDistrict(e.target.value as District)} data-testid="checkout-district">
          <option value="">—</option>
          {TASHKENT_DISTRICTS.map((d) => (
            <option key={d} value={d}>
              {t(`district.${d}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {t("checkout.address")}
        <textarea
          rows={2}
          value={address}
          maxLength={300}
          placeholder={t("checkout.address_placeholder")}
          onChange={(e) => setAddress(e.target.value)}
          data-testid="checkout-address"
        />
      </label>
      <label className="field">
        {t("checkout.comment")}
        <input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} />
      </label>

      {quote && (
        <section className="card stack" data-testid="checkout-quote">
          <div className="row between">
            <span>{t("checkout.item")}</span>
            <span>{formatUzs(quote.itemPrice)}</span>
          </div>
          <div className="row between">
            <span>{t("checkout.delivery_fee")}</span>
            <span>{quote.tariffId ? formatUzs(quote.deliveryFee) : t("checkout.no_tariff")}</span>
          </div>
          {quote.codFee > 0 && (
            <div className="row between">
              <span>{t("checkout.cod_fee")}</span>
              <span>{formatUzs(quote.codFee)}</span>
            </div>
          )}
          {sellerPart && (
            <p className="hint">
              {formatUzs(quote.sellerFee)} — {t("checkout.paid_by_seller")}
            </p>
          )}
          <div className="row between">
            <strong>{mode === "delivery_only" ? t("checkout.delivery_fee") : t("checkout.pay_courier")}</strong>
            <strong data-testid="checkout-total">{formatUzs(mode === "delivery_only" ? quote.buyerFee : quote.buyerTotal)}</strong>
          </div>
          {mode === "delivery_only" && <p className="hint">{t("checkout.pay_direct")}</p>}
        </section>
      )}

      <p className="hint-card">🔍 {t("checkout.inspection")}</p>

      {needPhone && (
        <div className="card stack">
          <p>{t("order.err.phone_required")}</p>
          <button className="secondary" onClick={sharePhone}>
            📱 {t("sell.share_phone")}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary"
        disabled={busy || !district || address.trim().length < 5}
        onClick={submit}
        data-testid="checkout-submit"
      >
        {t("checkout.submit")}
      </button>
    </div>
  );
}
