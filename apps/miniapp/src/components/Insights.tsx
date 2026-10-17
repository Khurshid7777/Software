import { useEffect, useState } from "react";
import { formatUzs, type InsightTip, type ListingInsights } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { useT } from "../i18n";

/** Tips that the seller fixes in the editor vs. by bumping the listing. */
const EDIT_TIPS: InsightTip[] = ["price_above_market", "favorites_no_requests", "few_photos", "short_description", "no_checklist", "no_account_check", "no_imei", "no_cod"];
const BUMP_TIPS: InsightTip[] = ["low_views", "stale"];

/** "Почему не продаётся": numbers of the listing and concrete next steps. */
export function Insights({ api, listingId, onEdit, onBump }: { api: Api; listingId: string; onEdit: () => void; onBump: () => void }) {
  const t = useT();
  const [data, setData] = useState<ListingInsights | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .insights(listingId)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : t("common.error")));
  }, [api, listingId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="hint">{t("common.loading")}</p>;
  const s = data.stats;
  return (
    <div className="insights stack" data-testid="insights">
      <strong>💡 {t("insights.title")}</strong>
      <div className="facts">
        <div className="fact">
          <strong>{s.daysOnSale}</strong>
          <span className="hint">{t("insights.days")}</span>
        </div>
        <div className="fact">
          <strong>{s.viewsPerDay}</strong>
          <span className="hint">{t("insights.views_day")}</span>
        </div>
        <div className="fact">
          <strong>{s.favorites}</strong>
          <span className="hint">{t("insights.favorites")}</span>
        </div>
        <div className="fact">
          <strong>{s.requests}</strong>
          <span className="hint">{t("insights.requests")}</span>
        </div>
      </div>
      {s.categoryViewsPerDay != null && <span className="hint">{t("insights.views_avg", { n: s.categoryViewsPerDay })}</span>}
      {data.market && (
        <span className="hint">
          {t("insights.market", {
            median: formatUzs(data.market.median),
            sign: data.market.diffPct > 0 ? "+" : "",
            pct: data.market.diffPct,
          })}
        </span>
      )}
      {data.tips.length === 0 ? (
        <p className="hint-card">✅ {t("insights.all_good")}</p>
      ) : (
        <ul className="plain tips">
          {data.tips.map((tip) => (
            <li key={tip.code} className={`tip tip-${tip.severity}`} data-testid={`tip-${tip.code}`}>
              <span>{t(`insights.tip.${tip.code}`, tip.params)}</span>
              {EDIT_TIPS.includes(tip.code) && (
                <button className="chip" onClick={onEdit}>
                  ✏️ {t("insights.action.edit")}
                </button>
              )}
              {BUMP_TIPS.includes(tip.code) && (
                <button className="chip" onClick={onBump}>
                  ⬆️ {t("insights.action.bump")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
