import { useEffect, useRef, useState } from "react";
import {
  GUARANTEE_DAYS,
  INSPECTION_MINUTES,
  MAX_FLOOR,
  TASHKENT_DISTRICTS,
  formatUzs,
  isCargo,
  listingTitle,
  type BundleQuote,
  type DeliveryMode,
  type DeliveryQuote,
  type District,
  type ListingDto,
} from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { BuyerPromise } from "../components/Promise";
import { useLang, useT } from "../i18n";
import { sharePhoneAndWait } from "../phone";
import { useLeaveGuard } from "../leave";
import { readPref, writePref } from "../prefs";
import { ensureWriteAccess, haptic } from "../telegram";

interface Props {
  api: Api;
  listing: ListingDto;
  onDone: (orderId: string) => void;
  onHow?: () => void;
}

/** "Buy with delivery": mode, district and address → price breakdown → order request to the seller. */
export function Checkout({ api, listing, onDone, onHow }: Props) {
  const t = useT();
  const lang = useLang();
  const modes = listing.allowedDeliveryModes;
  const [mode, setMode] = useState<DeliveryMode>(modes.includes("cod_seller") ? "cod_seller" : modes[0]!);
  // The last address is remembered on this device: repeat buyers don't type it again.
  const [district, setDistrict] = useState<District | "">(() => (readPref("district") as District | null) ?? "");
  const [address, setAddress] = useState(() => readPref("address") ?? "");
  const initialAddress = useRef(address);
  const [comment, setComment] = useState("");
  const [quote, setQuote] = useState<(DeliveryQuote & { bundle: BundleQuote | null; offerId?: string | null }) | null>(null);
  const [candidates, setCandidates] = useState<ListingDto[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const extraKey = extras.join(",");
  // Big appliances go by cargo taxi: movers carry them up, paid per floor when there is no lift.
  const [floor, setFloor] = useState(() => Number(readPref("floor")) || 1);
  const [elevator, setElevator] = useState(() => readPref("elevator") === "1");

  useEffect(() => {
    api
      .bundleCandidates(listing.id)
      .then(setCandidates)
      .catch(() => undefined);
  }, [api, listing.id]);
  const fitting = candidates.filter((c) => c.allowedDeliveryModes.includes(mode));
  // Items that can't travel with the chosen mode drop out of the bundle.
  useEffect(() => {
    setExtras((xs) => xs.filter((id) => fitting.some((c) => c.id === id)));
  }, [mode, candidates]);
  const [error, setError] = useState<string | null>(null);
  const [needPhone, setNeedPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState(false);
  const cargo = isCargo(listing.category) || candidates.some((c) => extras.includes(c.id) && isCargo(c.category));
  const lift = cargo ? { floor, elevator } : null;
  useLeaveGuard(!placed && ((address.trim().length > 0 && address !== initialAddress.current) || comment.trim().length > 0), t("checkout.leave_confirm"));

  useEffect(() => {
    if (!district) return;
    let current = true; // a slower answer for a previous district/mode must not overwrite this one
    setQuote(null);
    setError(null);
    api
      .quote(listing.id, district, mode, extras, lift)
      .then((q) => current && setQuote(q))
      .catch((e) => current && setError(e instanceof ApiError ? e.message : t("common.error")));
    return () => {
      current = false;
    };
  }, [api, listing.id, district, mode, extraKey, cargo, floor, elevator]);

  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const [waitingPhone, setWaitingPhone] = useState(false);
  const [writeDenied, setWriteDenied] = useState(false);

  async function submit() {
    if (busy || !district || !quote || address.trim().length < 5) return;
    setError(null);
    setBusy(true);
    try {
      // Status updates arrive from the bot; ask once so Telegram lets it write to the buyer.
      if (!(await ensureWriteAccess())) setWriteDenied(true);
      const order = await api.createOrder({
        listingId: listing.id,
        mode,
        district,
        address: address.trim(),
        comment: comment.trim() || undefined,
        ...(extras.length ? { extraListingIds: extras } : {}),
        ...(lift ? { floor: lift.floor, elevator: lift.elevator } : {}),
      });
      setPlaced(true);
      haptic("success");
      writePref("district", district);
      writePref("address", address.trim());
      if (lift) {
        writePref("floor", String(lift.floor));
        writePref("elevator", lift.elevator ? "1" : "0");
      }
      onDone(order.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "phone_required") setNeedPhone(true);
      else setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function sharePhone() {
    if (waitingPhone) return;
    setWaitingPhone(true);
    const r = await sharePhoneAndWait(api, () => mounted.current);
    if (!mounted.current) return; // left the screen: never place an order the user abandoned
    setWaitingPhone(false);
    if (r === "ok") {
      setNeedPhone(false);
      return submit();
    }
    if (r === "timeout") setError(t("phone.timeout"));
  }

  // With a bundle the breakdown sums every item; the delivery fee is in the first one only.
  const all = quote ? [quote as DeliveryQuote, ...(quote.bundle?.items.map((i) => i.quote) ?? [])] : [];
  const sum = (k: keyof DeliveryQuote) => all.reduce((s, q) => s + (q[k] as number), 0);
  const sellerPart = quote && sum("sellerFee") > 0;
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

      {fitting.length > 0 && (
        <section className="card stack" data-testid="bundle-candidates">
          <h3>🧺 {t("checkout.bundle_title")}</h3>
          <p className="hint">{t("checkout.bundle_hint")}</p>
          {fitting.map((c) => (
            <label key={c.id} className="check-row">
              <input
                type="checkbox"
                checked={extras.includes(c.id)}
                disabled={!extras.includes(c.id) && extras.length >= 4}
                onChange={(e) => setExtras((xs) => (e.target.checked ? [...xs, c.id] : xs.filter((x) => x !== c.id)))}
                data-testid="bundle-add"
              />
              <span>
                {listingTitle(c, lang)} <span className="hint">{c.price ? formatUzs(c.price) : ""}</span>
              </span>
            </label>
          ))}
        </section>
      )}

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
      {cargo && (
        <section className="card stack" data-testid="checkout-cargo">
          <p className="hint">{t("checkout.cargo")}</p>
          <label className="field">
            {t("checkout.floor")}
            <select value={floor} onChange={(e) => setFloor(Number(e.target.value))} data-testid="checkout-floor">
              {Array.from({ length: MAX_FLOOR }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={elevator} onChange={(e) => setElevator(e.target.checked)} data-testid="checkout-elevator" />
            {t("checkout.elevator")}
          </label>
        </section>
      )}
      <label className="field">
        {t("checkout.comment")}
        <input value={comment} maxLength={300} onChange={(e) => setComment(e.target.value)} data-testid="checkout-comment" />
        <span className="chips">
          {(["call_ahead", "after_18", "no_intercom"] as const).map((c) => (
            <button
              key={c}
              type="button"
              className="chip"
              onClick={() => setComment((v) => (v.includes(t(`checkout.quick.${c}`)) ? v : [v.trim(), t(`checkout.quick.${c}`)].filter(Boolean).join(", ").slice(0, 300)))}
            >
              {t(`checkout.quick.${c}`)}
            </button>
          ))}
        </span>
      </label>

      {quote && (
        <section className="card stack" data-testid="checkout-quote">
          <div className="row between">
            <span>{all.length > 1 ? t("checkout.bundle_items", { n: all.length }) : t("checkout.item")}</span>
            <span>{formatUzs(sum("itemPrice"))}</span>
          </div>
          {quote.offerId && listing.price != null && quote.itemPrice < listing.price && (
            <p className="hint" data-testid="offer-applied">🤝 {t("checkout.offer_applied", { amount: formatUzs(quote.itemPrice) })}</p>
          )}
          <div className="row between">
            <span>{t("checkout.delivery_fee")}</span>
            <span>{quote.tariffId ? formatUzs(quote.deliveryFee) : t("checkout.no_tariff")}</span>
          </div>
          {quote.liftFee > 0 && quote.lift && (
            <div className="row between" data-testid="checkout-lift-fee">
              <span>{t("checkout.lift_fee", { floor: quote.lift.floor })}</span>
              <span>{formatUzs(quote.liftFee)}</span>
            </div>
          )}
          {sum("codFee") > 0 && (
            <div className="row between">
              <span>{t("checkout.cod_fee")}</span>
              <span>{formatUzs(sum("codFee"))}</span>
            </div>
          )}
          {sellerPart && (
            <p className="hint">
              {formatUzs(sum("sellerFee"))} — {t("checkout.paid_by_seller")}
            </p>
          )}
          {quote.bundle && quote.bundle.discount > 0 && (
            <div className="row between" data-testid="bundle-discount">
              <span>{t("checkout.bundle_discount", { pct: quote.bundle.discountPct })}</span>
              <span>−{formatUzs(quote.bundle.discount)}</span>
            </div>
          )}
          {quote.bundle && quote.bundle.saved > 0 && (
            <p className="hint" data-testid="bundle-saved">🧺 {t("checkout.bundle_saved", { amount: formatUzs(quote.bundle.saved) })}</p>
          )}
          <div className="row between">
            <strong>{mode === "delivery_only" ? t("checkout.delivery_fee") : t("checkout.pay_courier")}</strong>
            <strong data-testid="checkout-total">{formatUzs(mode === "delivery_only" ? sum("buyerFee") : sum("buyerTotal"))}</strong>
          </div>
          {mode === "delivery_only" && <p className="hint">{t("checkout.pay_direct")}</p>}
        </section>
      )}

      {district && !quote && !error && <p className="hint center">⏳ {t("checkout.calculating")}</p>}
      <BuyerPromise onOpen={onHow} />
      <p className="hint-card" data-testid="checkout-inspection">
        {t("checkout.inspection", { min: INSPECTION_MINUTES })}
        <br />
        {t("guarantee.checkout", { days: GUARANTEE_DAYS })}
      </p>

      {needPhone && (
        <div className="card stack">
          <p>{t("order.err.phone_required")}</p>
          <button className="secondary" onClick={sharePhone} disabled={waitingPhone}>
            📱 {t("sell.share_phone")}
          </button>
        </div>
      )}
      {writeDenied && <p className="hint">{t("listing.write_access")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary"
        disabled={busy || !district || !quote || address.trim().length < 5}
        onClick={submit}
        data-testid="checkout-submit"
      >
        {busy ? t("common.loading") : t("checkout.submit")}
      </button>
      {/* Why the button is disabled, instead of a silent grey button. */}
      {!busy && (!district || address.trim().length < 5) && (
        <p className="hint center" data-testid="checkout-missing">
          {!district ? t("checkout.need_district") : t("checkout.need_address")}
        </p>
      )}
    </div>
  );
}
