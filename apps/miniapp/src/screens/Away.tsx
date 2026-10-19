import { useEffect, useState } from "react";
import { AWAY_MAX_DAYS } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useLang, useT } from "../i18n";

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * «В отъезде» (stage 28, Vinted "holiday mode"): until the chosen day the seller's listings leave the catalog
 * and take no orders, meetings or offers. Messages still arrive. It ends by itself.
 */
export function Away({ api }: { api: Api }) {
  const t = useT();
  const lang = useLang();
  const [until, setUntil] = useState<string | null | undefined>(undefined);
  const [date, setDate] = useState(isoDay(new Date(Date.now() + 7 * DAY)));
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    setFailed(false);
    api
      .me()
      .then((me) => setUntil(me.awayUntil ?? null))
      .catch(() => setFailed(true));
  };
  useEffect(load, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(value: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      // The end of the chosen day in Tashkent (UTC+5).
      const r = await api.setAway(value ? new Date(`${value}T23:59:00+05:00`).toISOString() : null);
      setUntil(r.awayUntil);
      setToast(t(r.awayUntil ? "away.on_toast" : "away.off_toast"));
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  if (failed) return <LoadError onRetry={load} />;
  if (until === undefined) return <p className="hint center">{t("common.loading")}</p>;
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ", { day: "numeric", month: "long" });
  return (
    <div className="stack" data-testid="away">
      <h1>🏖 {t("away.title")}</h1>
      <p className="hint">{t("away.hint", { days: AWAY_MAX_DAYS })}</p>
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
      {until ? (
        <div className="card stack-tight">
          <strong data-testid="away-status">{t("away.status", { date: fmt(until) })}</strong>
          <button className="primary" disabled={busy} onClick={() => save(null)} data-testid="away-off">
            {t("away.back")}
          </button>
        </div>
      ) : (
        <div className="card stack-tight">
          <label className="field">
            {t("away.until")}
            <input
              type="date"
              value={date}
              min={isoDay(new Date())}
              max={isoDay(new Date(Date.now() + (AWAY_MAX_DAYS - 1) * DAY))}
              onChange={(e) => setDate(e.target.value)}
              data-testid="away-date"
            />
          </label>
          <button className="primary" disabled={busy || !date} onClick={() => save(date)} data-testid="away-on">
            {t("away.start")}
          </button>
        </div>
      )}
    </div>
  );
}
