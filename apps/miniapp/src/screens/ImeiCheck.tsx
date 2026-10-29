import { useState } from "react";
import { isValidImei, normalizeImei, type ImeiCheckDto } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { Icon, type IconName } from "../components/Icon";
import { useT } from "../i18n";
import { haptic } from "../telegram";

const ICON: Record<ImeiCheckDto["verdict"], IconName> = { invalid: "alert", danger: "cross", caution: "alert", clean: "ok" };

/** «Проверка IMEI»: any phone, before it is bought anywhere. Answers with a verdict and counts, never a name. */
export function ImeiCheck({ api, onInspect }: { api: Api; onInspect: () => void }) {
  const t = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<ImeiCheckDto | null>(null);
  const clean = normalizeImei(value);
  const ready = clean.length === 15;

  async function run() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.checkImei(clean);
      setRes(r);
      haptic(r.verdict === "clean" ? "success" : r.verdict === "invalid" ? "warning" : "error");
    } catch (e) {
      setRes(null);
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack imei" data-testid="imei-check">
      <header className="how-head">
        <h1>{t("imei.title")}</h1>
        <p className="hint">{t("imei.intro")}</p>
      </header>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          inputMode="numeric"
          autoComplete="off"
          maxLength={20}
          placeholder={t("imei.placeholder")}
          value={value}
          onChange={(e) => {
            setValue(e.target.value.replace(/[^\d\s-]/g, ""));
            setRes(null);
          }}
          data-testid="imei-input"
        />
        <button className="primary" type="submit" disabled={!ready || busy} data-testid="imei-run">
          {busy ? t("imei.checking") : t("imei.check")}
        </button>
        {value && !ready && clean.length > 0 && <p className="hint center">{clean.length} / 15</p>}
        {ready && !isValidImei(clean) && !res && <p className="hint center">{t("imei.invalid.text")}</p>}
      </form>
      {error && (
        <p className="error" role="alert" data-testid="imei-error">
          {error}
        </p>
      )}

      {res && (
        <section className={`imei-result verdict-${res.verdict}`} data-testid="imei-result" data-verdict={res.verdict}>
          <div className="imei-head">
            <Icon name={ICON[res.verdict]} />
            <div>
              <strong>{t(`imei.${res.verdict}.title`)}</strong>
              <p>{t(`imei.${res.verdict}.text`)}</p>
            </div>
          </div>
          {res.verdict !== "invalid" && (
            <ul className="plain imei-facts">
              <li data-testid="imei-seen">
                {res.seen.listings === 0 ? t("imei.seen.never") : t("imei.seen.some", { listings: res.seen.listings, sold: res.seen.sold, active: res.seen.active })}
              </li>
              {res.seen.inspections.passed + res.seen.inspections.failed > 0 && <li>{t("imei.seen.inspections", res.seen.inspections)}</li>}
            </ul>
          )}
          {res.verdict !== "invalid" && (
            <div className="stack-tight">
              <h3>{t("imei.next.title")}</h3>
              <ul className="plain how-checklist">
                {(["uzimei", "match", "account", "inspect"] as const).map((k) => (
                  <li key={k}>
                    <Icon name="check" /> {t(`imei.next.${k}`, { tail: res.tail ?? "" })}
                  </li>
                ))}
              </ul>
              <button className="link" onClick={onInspect}>
                {t("how.try")}
              </button>
            </div>
          )}
          <p className="hint center">{t("imei.left", { n: res.checksLeft })}</p>
        </section>
      )}
    </div>
  );
}
