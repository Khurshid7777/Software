import { useState } from "react";
import { DISPUTE_REASONS, formatUzs, type DisputeReason, type OrderDto } from "@ishonch/shared/client";
import { useLang, useT } from "../i18n";

/**
 * Ishonch guarantee on a delivered order: the window badge and the buyer's dispute form; the dispute's state
 * for both sides and the seller's one answer.
 */
export function Guarantee({
  order: o,
  onOpen,
  onRespond,
}: {
  order: OrderDto;
  onOpen: (reason: DisputeReason, text: string) => void;
  onRespond: (text: string) => void;
}) {
  const t = useT();
  const lang = useLang();
  const [form, setForm] = useState<{ reason: DisputeReason | null; text: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const d = o.dispute;
  const canOpen = o.actions.includes("dispute");
  if (!d && !canOpen) return null;
  const date = (iso: string) => new Date(iso).toLocaleString(lang === "ru" ? "ru-RU" : "uz-UZ", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="stack guarantee" data-testid="guarantee">
      {canOpen && o.guaranteeUntil && (
        <>
          <p className="hint-card" data-testid="guarantee-badge">
            {t("guarantee.badge", { date: date(o.guaranteeUntil) })}
            <br />
            <span className="hint">{t("guarantee.hint")}</span>
          </p>
          {form ? (
            <div className="stack" data-testid="dispute-form">
              <strong>{t("guarantee.reason")}</strong>
              <div className="chips">
                {DISPUTE_REASONS.map((r) => (
                  <button key={r} className={form.reason === r ? "chip active" : "chip"} onClick={() => setForm({ ...form, reason: r })} data-testid={`dispute-reason-${r}`}>
                    {t(`dispute.reason.${r}`)}
                  </button>
                ))}
              </div>
              <label className="field">
                {t("guarantee.text")}
                <textarea
                  rows={3}
                  maxLength={1000}
                  value={form.text}
                  placeholder={t("guarantee.text_placeholder")}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                  data-testid="dispute-text"
                />
              </label>
              <button
                className="primary"
                disabled={!form.reason || form.text.trim().length < 10}
                onClick={() => onOpen(form.reason!, form.text.trim())}
                data-testid="dispute-send"
              >
                {t("guarantee.send")}
              </button>
            </div>
          ) : (
            <button className="chip" onClick={() => setForm({ reason: null, text: "" })} data-testid="dispute-open">
              {t("guarantee.open")}
            </button>
          )}
        </>
      )}

      {d && (
        <div className="hint-card stack-tight" data-testid="dispute-status">
          <strong>
            {d.status === "open"
              ? t("dispute.status.open", { reason: t(`dispute.reason.${d.reason}`) })
              : t("dispute.status.resolved", { outcome: t(`dispute.resolution.${d.resolution!}`, { amount: d.amount ? formatUzs(d.amount) : "" }) })}
          </strong>
          <span className="hint">«{d.text}»</span>
          {d.sellerResponse && <span className="hint">{t("dispute.seller_response", { text: d.sellerResponse })}</span>}
          {d.note && <span className="hint">{d.note}</span>}
        </div>
      )}

      {o.actions.includes("dispute_response") && (
        <div className="stack" data-testid="dispute-response">
          <textarea
            rows={3}
            maxLength={1000}
            value={answer}
            placeholder={t("dispute.respond_placeholder")}
            onChange={(e) => setAnswer(e.target.value)}
            data-testid="dispute-answer"
          />
          <button className="secondary" disabled={answer.trim().length < 3} onClick={() => onRespond(answer.trim())} data-testid="dispute-answer-send">
            {t("dispute.respond_send")}
          </button>
        </div>
      )}
    </div>
  );
}
