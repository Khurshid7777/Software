import { useEffect, useState } from "react";
import { CONDITIONS, formatUzs, prettyModel, type Condition, type Valuation as ValuationResult } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { useLang, useT } from "../i18n";
import { haptic } from "../telegram";

/**
 * «Сколько стоит?»: model + condition → the market price for that condition, what sold on Ishonch lately
 * and how the price moved by month. The way in for sellers: one tap to "sell in 2 minutes".
 */
export function Valuation({ api, onSell }: { api: Api; onSell: () => void }) {
  const t = useT();
  const lang = useLang();
  const [query, setQuery] = useState("");
  const [condition, setCondition] = useState<Condition>("good");
  const [models, setModels] = useState<string[]>([]);
  const [result, setResult] = useState<ValuationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Model names from the price reference while typing (debounced).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setModels([]);
    let current = true;
    const timer = setTimeout(() => {
      api
        .valuationModels(q)
        .then((r) => current && setModels(r.models))
        .catch(() => undefined);
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, query]);

  async function evaluate(q = query, c = condition) {
    if (q.trim().length < 2 || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.valuation(q.trim(), c));
      haptic("light");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const month = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ", { month: "short" });
  const top = result ? Math.max(...result.history.map((h) => h.median), 1) : 1;

  return (
    <div className="stack" data-testid="valuation">
      <header className="stack-tight">
        <h1>💰 {t("valuation.title")}</h1>
        <p className="hint">{t("valuation.subtitle")}</p>
      </header>

      <form
        className="card stack"
        onSubmit={(e) => {
          e.preventDefault();
          void evaluate();
        }}
      >
        <label className="field">
          {t("valuation.model")}
          <input
            list="valuation-models"
            value={query}
            maxLength={120}
            placeholder={t("valuation.model_placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="valuation-model"
          />
          <datalist id="valuation-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <span>{t("valuation.condition")}</span>
        <div className="chips">
          {CONDITIONS.map((c) => (
            <button
              type="button"
              key={c}
              className={condition === c ? "chip active" : "chip"}
              onClick={() => {
                setCondition(c);
                if (result) void evaluate(query, c);
              }}
              data-testid={`valuation-condition-${c}`}
            >
              {t(`condition.${c}`)}
            </button>
          ))}
        </div>
        <button className="primary" disabled={busy || query.trim().length < 2} data-testid="valuation-submit">
          {busy ? t("common.loading") : t("valuation.submit")}
        </button>
      </form>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <section className="card stack" data-testid="valuation-result">
          <h2>{prettyModel(result.modelKey)}</h2>
          {result.estimate ? (
            <>
              <div className="facts valuation-facts">
                <Fact value={formatUzs(result.estimate.quick)} label={t("valuation.quick")} />
                <Fact value={formatUzs(result.estimate.market)} label={t("valuation.market")} strong />
                <Fact value={formatUzs(result.estimate.max)} label={t("valuation.max")} />
              </div>
              <span className="hint">{t(`valuation.source.${result.source === "catalog" ? "catalog" : "reference"}`)}</span>
            </>
          ) : (
            <p className="hint" data-testid="valuation-none">
              {t("valuation.none")}
            </p>
          )}
          {result.sold.count > 0 && result.sold.median != null && (
            <span className="hint">✅ {t("valuation.sold", { n: result.sold.count, median: formatUzs(result.sold.median) })}</span>
          )}
          {result.live > 0 && <span className="hint">🛒 {t("valuation.live", { n: result.live })}</span>}
          {result.history.length > 1 && (
            <div className="stack-tight" data-testid="valuation-history">
              <h3>{t("valuation.history")}</h3>
              <div className="history-bars">
                {result.history.map((h) => (
                  <div key={h.month} className="history-bar" title={formatUzs(h.median)}>
                    <span className="history-value">{Math.round(h.median / 100_000) / 10}</span>
                    <span className="history-fill" style={{ height: `${Math.max(8, (h.median / top) * 100)}%` }} />
                    <span className="hint">{month(h.month)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <button className="primary" onClick={onSell} data-testid="valuation-sell">
            📸 {t("valuation.sell")}
          </button>
        </section>
      )}
    </div>
  );
}

function Fact({ value, label, strong }: { value: string; label: string; strong?: boolean }) {
  return (
    <div className={strong ? "fact fact-main" : "fact"}>
      <strong>{value}</strong>
      <span className="hint">{label}</span>
    </div>
  );
}
