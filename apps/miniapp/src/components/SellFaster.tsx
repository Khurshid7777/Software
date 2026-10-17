import { useState } from "react";
import {
  AUTO_DROP_MIN_FLOOR_PCT,
  LIKERS_OFFER_MIN_PCT,
  formatUzs,
  maxLikersOffer,
  type ListingDto,
} from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { useLang, useT } from "../i18n";
import { groupDigits } from "../prefs";

/**
 * «Продавать быстрее» on an active listing (docs/plan.md, stage 16): a one-off price for those who saved the
 * item (Poshmark "Offer to Likers") and a gradual price drop down to the seller's floor (Mercari Smart Pricing).
 */
export function SellFaster({
  api,
  listing: l,
  actions = true,
  onDone,
}: {
  api: Api;
  listing: ListingDto;
  /** false: only the running auto drop / last offer lines (the card's «⋯ Ещё» is closed). */
  actions?: boolean;
  onDone: (toast: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const [mode, setMode] = useState<"likers" | "autodrop" | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!l.price) return null;
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ", {
      day: "numeric",
      month: "long",
    });

  function open(m: "likers" | "autodrop") {
    setError(null);
    setMode(mode === m ? null : m);
    setAmount(
      m === "likers"
        ? String(maxLikersOffer(l.price!))
        : String(Math.ceil((l.price! * 0.8) / 10_000) * 10_000),
    );
  }

  async function run(fn: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const toast = await fn();
      setMode(null);
      onDone(toast);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }
  const value = Number(amount.replace(/\D/g, ""));

  return (
    <div className="stack-tight" data-testid="sell-faster">
      {l.autoDrop && (
        <span className="hint" data-testid="autodrop-status">
          {t("autodrop.on", {
            floor: formatUzs(l.autoDrop.floor),
            date: date(l.autoDrop.nextAt),
          })}
        </span>
      )}
      {l.likersOffer && (
        <span className="hint" data-testid="likers-last">
          {t("likers.last", {
            price: formatUzs(l.likersOffer.price),
            date: date(l.likersOffer.at),
          })}
        </span>
      )}
      {actions && (
        <div className="row wrap">
          {l.stats.favorites > 0 && (
            <button
              className={mode === "likers" ? "chip active" : "chip"}
              onClick={() => open("likers")}
              data-testid="likers-open"
            >
              {t("likers.button", { n: l.stats.favorites })}
            </button>
          )}
          {l.autoDrop ? (
            <button
              className="chip"
              onClick={() =>
                run(() =>
                  api
                    .updateListing(l.id, { autoDropFloor: null })
                    .then(() => t("autodrop.stopped")),
                )
              }
              data-testid="autodrop-stop"
            >
              ⏹ {t("autodrop.stop")}
            </button>
          ) : (
            <button
              className={mode === "autodrop" ? "chip active" : "chip"}
              onClick={() => open("autodrop")}
              data-testid="autodrop-open"
            >
              {t("autodrop.button")}
            </button>
          )}
        </div>
      )}
      {actions && mode && (
        <div className="hint-card stack-tight" data-testid={`${mode}-form`}>
          <strong>
            {t(mode === "likers" ? "likers.title" : "autodrop.title")}
          </strong>
          <span className="hint">
            {mode === "likers"
              ? t("likers.hint", { pct: LIKERS_OFFER_MIN_PCT })
              : t("autodrop.hint")}
          </span>
          <label className="field">
            {t(mode === "likers" ? "likers.price" : "autodrop.floor")}
            <input
              inputMode="numeric"
              value={groupDigits(amount)}
              onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
              data-testid={`${mode}-amount`}
            />
          </label>
          {error && (
            <span className="error" data-testid="sell-faster-error">
              {error}
            </span>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              !value ||
              (mode === "autodrop" &&
                value < (l.price * AUTO_DROP_MIN_FLOOR_PCT) / 100)
            }
            onClick={() =>
              mode === "likers"
                ? run(() =>
                    api
                      .offerToLikers(l.id, value)
                      .then(
                        (r) =>
                          t("likers.sent", { n: r.sent }) +
                          (r.deferredUntil ? ` ${t("likers.deferred")}` : ""),
                      ),
                  )
                : run(() =>
                    api
                      .updateListing(l.id, { autoDropFloor: value })
                      .then(() => t("autodrop.saved")),
                  )
            }
            data-testid={`${mode}-send`}
          >
            {t(mode === "likers" ? "likers.send" : "autodrop.start")}
          </button>
        </div>
      )}
    </div>
  );
}
