import { useState } from "react";
import type { ListingDto, PromoOptions, PromoPlan } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { useLang, useT } from "../i18n";
import { payInvoice } from "../telegram";

/**
 * «📣 Продвинуть» on an active listing (docs/plan.md, stage 18): 3 or 7 days for Telegram Stars. The payment
 * sheet is Telegram's own; the promotion starts when the bot reports the payment, so we just reload.
 */
export function Promote({ api, listing: l, options, onDone }: { api: Api; listing: ListingDto; options: PromoOptions; onDone: (toast: string) => void }) {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<PromoPlan>("7d");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const date = (iso: string) => new Date(iso).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ", { day: "numeric", month: "long" });

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { invoiceLink } = await api.promote(l.id, plan);
      const status = await payInvoice(invoiceLink);
      if (status === "paid") {
        setOpen(false);
        onDone(t("promo.paid"));
      } else if (status === "cancelled") setError(t("promo.cancelled"));
      else if (status !== "unavailable") setError(t("common.error"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-tight" data-testid="promote">
      {l.promotedUntil && (
        <span className="hint" data-testid="promoted-until">
          {t("promo.until", { date: date(l.promotedUntil) })}
        </span>
      )}
      <div className="row wrap">
        <button className={open ? "chip active" : "chip"} onClick={() => setOpen(!open)} data-testid="promote-open">
          {t("promo.button")}
        </button>
      </div>
      {open && (
        <div className="hint-card stack-tight" data-testid="promote-form">
          <strong>{t("promo.title")}</strong>
          <span className="hint">{t("promo.hint")}</span>
          <div className="chips">
            {options.plans.map((p) => (
              <button key={p.plan} className={plan === p.plan ? "chip active" : "chip"} onClick={() => setPlan(p.plan)} data-testid={`promote-plan-${p.plan}`}>
                {t("promo.plan", { days: p.days, stars: p.stars })}
              </button>
            ))}
          </div>
          {error && <span className="error">{error}</span>}
          <button className="primary" disabled={busy} onClick={pay} data-testid="promote-pay">
            ⭐ {t("promo.pay")}
          </button>
        </div>
      )}
    </div>
  );
}
