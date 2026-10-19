import { useEffect, useState } from "react";
import { isValidImei, normalizeImei, type StolenKind, type StolenReportDto } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { confirmDialog } from "../dialogs";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useLang, useT } from "../i18n";

/**
 * «Украли телефон» (stage 27): the owner reports the IMEI of a stolen or lost phone. If it shows up in a listing,
 * the listing goes to a moderator; the seller never learns who reported it.
 */
export function Stolen({ api }: { api: Api }) {
  const t = useT();
  const lang = useLang();
  const [items, setItems] = useState<StolenReportDto[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [imei, setImei] = useState("");
  const [kind, setKind] = useState<StolenKind>("stolen");
  const [police, setPolice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => {
    setFailed(false);
    api
      .stolenReports()
      .then(setItems)
      .catch(() => (setItems([]), setFailed(true)));
  };
  useEffect(load, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = isValidImei(normalizeImei(imei));

  async function submit() {
    if (busy || !valid) return;
    setBusy(true);
    try {
      const r = await api.reportStolen({ imei, kind, policeReport: police.trim() || undefined });
      setImei("");
      setPolice("");
      setToast(r.held > 0 ? t("stolen.sent_held", { n: r.held }) : t("stolen.sent"));
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" data-testid="stolen">
      <h1>🚨 {t("stolen.title")}</h1>
      <p className="hint">{t("stolen.hint")}</p>
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
      <div className="card stack-tight">
        <div className="row wrap" role="group">
          {(["stolen", "lost"] as const).map((k) => (
            <button key={k} className={kind === k ? "chip active" : "chip"} onClick={() => setKind(k)} aria-pressed={kind === k}>
              {t(`stolen.kind.${k}`)}
            </button>
          ))}
        </div>
        <label className="field">
          {t("stolen.imei")}
          <input inputMode="numeric" value={imei} onChange={(e) => setImei(e.target.value)} placeholder="35xxxxxxxxxxxxx" data-testid="stolen-imei" />
          <span className="hint">{imei && !valid ? t("stolen.err.bad_imei") : t("stolen.imei_hint")}</span>
        </label>
        <label className="field">
          {t("stolen.police")}
          <input value={police} maxLength={100} onChange={(e) => setPolice(e.target.value)} data-testid="stolen-police" />
        </label>
        <button className="primary" disabled={busy || !valid} onClick={submit} data-testid="stolen-send">
          {t("stolen.send")}
        </button>
      </div>

      {failed && <LoadError onRetry={load} />}
      {items && items.length > 0 && <h2>{t("stolen.mine")}</h2>}
      {items?.map((r) => (
        <div key={r.id} className="card row between" data-testid="stolen-row">
          <span>
            {t(`stolen.kind.${r.kind}`)} · IMEI …{r.imeiTail}
            <span className="hint"> · {new Date(r.createdAt).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ")}</span>
          </span>
          <button
            className="link"
            onClick={async () => {
              if (!(await confirmDialog(t("stolen.found_confirm")))) return;
              api
                .withdrawStolen(r.id)
                .then(load)
                .catch((e) => setToast(e instanceof ApiError ? e.message : t("common.error")));
            }}
            data-testid="stolen-found"
          >
            {t("stolen.found")}
          </button>
        </div>
      ))}
    </div>
  );
}
