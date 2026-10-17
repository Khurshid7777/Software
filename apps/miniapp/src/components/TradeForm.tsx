import { useState } from "react";
import { CONDITIONS, type Condition, type OfferDto } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { useT } from "../i18n";
import { digitsOnly, groupDigits } from "../prefs";
import { ensureWriteAccess } from "../telegram";

type Direction = "me" | "them" | "zero";

/** «Обмен с доплатой»: the buyer's item, its condition and who adds money; the seller answers in the bot. */
export function TradeForm({ api, listingId, onSent, onError }: { api: Api; listingId: string; onSent: (o: OfferDto) => void; onError: (m: string) => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [condition, setCondition] = useState<Condition>("good");
  const [description, setDescription] = useState("");
  const [direction, setDirection] = useState<Direction>("me");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const sum = Number(amount) || 0;
  const ready = title.trim().length >= 3 && (direction === "zero" || sum > 0);

  async function send() {
    if (!ready || busy) return;
    if (!(await ensureWriteAccess())) return onError(t("listing.write_access"));
    setBusy(true);
    try {
      const topUp = direction === "zero" ? 0 : direction === "me" ? sum : -sum;
      onSent(await api.tradeOffer(listingId, { title: title.trim(), condition, description: description.trim() || undefined, topUp }));
    } catch (e) {
      onError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" data-testid="trade-form">
      <label className="field">
        {t("trade.item_title")}
        <input value={title} maxLength={120} placeholder={t("trade.item_placeholder")} onChange={(e) => setTitle(e.target.value)} data-testid="trade-title" />
      </label>
      <span>{t("trade.condition")}</span>
      <div className="chips">
        {CONDITIONS.map((c) => (
          <button key={c} className={condition === c ? "chip active" : "chip"} onClick={() => setCondition(c)}>
            {t(`condition.${c}`)}
          </button>
        ))}
      </div>
      <label className="field">
        {t("trade.description")}
        <input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <span>{t("trade.topup")}</span>
      <div className="chips">
        {(["me", "them", "zero"] as const).map((d) => (
          <button key={d} className={direction === d ? "chip active" : "chip"} onClick={() => setDirection(d)} data-testid={`trade-dir-${d}`}>
            {t(d === "me" ? "trade.topup_me" : d === "them" ? "trade.topup_them" : "trade.topup_zero")}
          </button>
        ))}
      </div>
      {direction !== "zero" && (
        <label className="field">
          {t("trade.amount")}
          <input inputMode="numeric" value={groupDigits(amount)} onChange={(e) => setAmount(digitsOnly(e.target.value))} data-testid="trade-amount" />
        </label>
      )}
      <button className="secondary" onClick={send} disabled={!ready || busy} data-testid="trade-send">
        {busy ? t("common.loading") : t("trade.send")}
      </button>
    </div>
  );
}
