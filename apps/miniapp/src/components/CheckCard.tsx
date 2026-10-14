import { formatUzs, type CheckResult } from "@ishonch/shared/client";
import { useT } from "../i18n";

const RISK_CLASS = { low: "risk-low", medium: "risk-medium", high: "risk-high" } as const;

export function CheckCard({ check }: { check: CheckResult }) {
  const t = useT();
  const p = check.price;
  const priceText =
    p.verdict === "unknown" || p.diffPct == null
      ? t("check.price.unknown")
      : t(`check.price.${p.verdict}`, { pct: Math.abs(p.diffPct) });

  return (
    <div className="stack" data-testid="check-card">
      <h2>{check.title}</h2>

      <section className="card">
        <h3>{t("check.price.title")}</h3>
        <p className={`verdict verdict-${p.verdict}`}>
          {priceText}
          {p.priceUzs ? ` · ${formatUzs(p.priceUzs)}` : ""}
        </p>
        {p.range && (
          <p className="hint">{t("check.price.range", { min: formatUzs(p.range.min), max: formatUzs(p.range.max) })}</p>
        )}
        {p.source !== "none" && <p className="hint">{t(`check.price.source.${p.source}`)}</p>}
      </section>

      <section className={`card ${RISK_CLASS[check.risk.level]}`}>
        <h3>{t("check.risk.title")}</h3>
        <p className="risk-level">
          {t(`check.risk.${check.risk.level}`)} <span className="hint">({check.risk.score}/100)</span>
        </p>
        {check.redFlags.length > 0 && (
          <>
            <h4>{t("check.flags.title")}</h4>
            <ul className="flags">
              {check.redFlags.map((f) => (
                <li key={f}>🚩 {f}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <div className="two-col">
        <section className="card">
          <h3>✅ {t("check.pros")}</h3>
          <ul>{check.pros.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
        <section className="card">
          <h3>⚠️ {t("check.cons")}</h3>
          <ul>{check.cons.map((x) => <li key={x}>{x}</li>)}</ul>
        </section>
      </div>

      <section className="card">
        <h3>❓ {t("check.questions")}</h3>
        <ol>{check.questions.map((q) => <li key={q}>{q}</li>)}</ol>
      </section>

      <section className="card">
        <h3>📋 {t("check.checklist")}</h3>
        <ul className="checklist">
          {check.checklist.map((c) => (
            <li key={c}>
              <label>
                <input type="checkbox" /> {c}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <p className="disclaimer">{t("ai.disclaimer")}</p>
    </div>
  );
}
