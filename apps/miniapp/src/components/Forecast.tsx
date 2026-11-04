import { FORECAST_YEARS, USAGE_LEVELS, forecastDevice, formatUzs, type ListingDto } from "@ishonch/shared/client";
import { useForecastSettings, type ForecastSettings } from "../forecast";
import { useT } from "../i18n";
import { Icon } from "./Icon";

/** The inputs a forecast needs, taken from a listing. */
export const forecastInput = (l: ListingDto) => ({ category: l.category, condition: l.condition, price: l.price, checklist: l.checklist ?? {} });

/** «Как вы будете пользоваться» and «на сколько лет вперёд»: two small chip rows. */
export function ForecastControls({ settings, onChange }: { settings: ForecastSettings; onChange: (n: Partial<ForecastSettings>) => void }) {
  const t = useT();
  return (
    <div className="stack-tight forecast-controls" data-testid="forecast-controls">
      <div className="chips" role="group" aria-label={t("forecast.usage")}>
        <span className="hint">{t("forecast.usage")}</span>
        {USAGE_LEVELS.map((u) => (
          <button key={u} className={settings.usage === u ? "chip active" : "chip"} aria-pressed={settings.usage === u} onClick={() => onChange({ usage: u })} data-testid={`usage-${u}`}>
            {t(`forecast.usage.${u}`)}
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label={t("forecast.horizon")}>
        <span className="hint">{t("forecast.horizon")}</span>
        {FORECAST_YEARS.map((y) => (
          <button key={y} className={settings.years === y ? "chip active" : "chip"} aria-pressed={settings.years === y} onClick={() => onChange({ years: y })} data-testid={`years-${y}`}>
            {t("forecast.years", { n: y })}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
  /** A band around the values (price), same length. */
  low?: number[];
  high?: number[];
}

/** A small line chart over years 0..N (SVG, no library); `max` fixes the top of the scale (100 for a battery). */
export function MiniChart({ series, max, format, label }: { series: ChartSeries[]; max?: number; format: (v: number) => string; label: string }) {
  const W = 300;
  const H = 150;
  const pad = { l: 8, r: 8, t: 10, b: 22 };
  const n = Math.max(...series.map((s) => s.values.length)) - 1;
  const top = max ?? Math.max(...series.flatMap((s) => s.high ?? s.values)) * 1.05;
  const x = (i: number) => pad.l + (i / Math.max(n, 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - Math.min(v, top) / top) * (H - pad.t - pad.b);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const desc = series.map((s) => `${s.label}: ${s.values.map(format).join(" → ")}`).join("; ");
  return (
    <figure className="mini-chart" data-testid="forecast-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}. ${desc}`}>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={pad.l} x2={W - pad.r} y1={y(top * f)} y2={y(top * f)} className="chart-grid" />
        ))}
        {series.map((s) =>
          s.low && s.high ? (
            <path key={`${s.key}-band`} d={`${path(s.high)} L${x(s.high.length - 1).toFixed(1)} ${y(s.low[s.low.length - 1]!).toFixed(1)} ${[...s.low].reverse().map((v, i) => `L${x(s.low!.length - 1 - i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")} Z`} fill={s.color} fillOpacity={0.12} stroke="none" />
          ) : null,
        )}
        {series.map((s) => (
          <g key={s.key}>
            <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
            {s.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={3.2} fill={s.color} />
            ))}
          </g>
        ))}
        {Array.from({ length: n + 1 }, (_, i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="chart-axis">
            {i}
          </text>
        ))}
      </svg>
      <figcaption className="chart-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} aria-hidden /> {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/**
 * «Что будет с устройством»: battery, service and price over the next years, for the use the buyer chooses.
 * Everything is a rough estimate from typical values for the category, and the card says so before the numbers.
 */
export function ForecastCard({ listing }: { listing: ListingDto }) {
  const t = useT();
  const [settings, set] = useForecastSettings();
  const f = forecastDevice(forecastInput(listing), settings.usage, settings.years);
  const last = f.price?.series[f.price.series.length - 1];
  return (
    <details className="card forecast" data-testid="forecast">
      <summary className="forecast-summary">
        <Icon name="trend_down" /> <strong>{t("forecast.title")}</strong>
        <Icon name="chevron" />
      </summary>
      <div className="stack">
        <p className="hint-card" data-testid="forecast-disclaimer">
          <Icon name="alert" /> {t("forecast.disclaimer")}
        </p>
        <ForecastControls settings={settings} onChange={set} />

        {f.battery && (
          <section className="stack-tight" data-testid="forecast-battery">
            <h2 className="h-sub">{t("forecast.battery")}</h2>
            <MiniChart
              label={t("forecast.battery")}
              max={100}
              format={(v) => `${Math.round(v)}%`}
              series={[{ key: "b", label: t("forecast.battery_series"), color: "var(--brand)", values: f.battery.series }]}
            />
            <p className="forecast-line">
              {t("forecast.battery_after", { n: f.years, pct: Math.round(f.battery.series[f.years]!) })}
              {f.battery.estimated && <span className="hint"> {t("forecast.battery_estimated", { pct: Math.round(f.battery.start) })}</span>}
            </p>
            <p className="forecast-line" data-testid="forecast-replace">
              {f.battery.replaceInMonths === 0 ? t("forecast.replace_now", { pct: f.battery.threshold }) : t("forecast.replace_in", { months: f.battery.replaceInMonths, pct: f.battery.threshold })}
            </p>
          </section>
        )}

        <section className="stack-tight" data-testid="forecast-service">
          <h2 className="h-sub">{t("forecast.service")}</h2>
          {f.maintenance.length === 0 ? (
            <p className="hint">{t("forecast.service_none")}</p>
          ) : (
            <ul className="plain forecast-tasks">
              {f.maintenance.map((m) => (
                <li key={m.key}>
                  <Icon name="wrench" />
                  <span>
                    <strong>{t(`forecast.maint.${m.key}`)}</strong>
                    <span className="hint">{t("forecast.maint_when", { months: m.inMonths, every: m.everyMonths })}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {f.price && last && (
          <section className="stack-tight" data-testid="forecast-price">
            <h2 className="h-sub">{t("forecast.price")}</h2>
            <MiniChart
              label={t("forecast.price")}
              format={(v) => formatUzs(v)}
              series={[{ key: "p", label: t("forecast.price_series"), color: "var(--ok)", values: f.price.series.map((p) => p.mid), low: f.price.series.map((p) => p.low), high: f.price.series.map((p) => p.high) }]}
            />
            <p className="forecast-line" data-testid="forecast-price-line">
              {t("forecast.price_after", { n: f.years, low: formatUzs(last.low), high: formatUzs(last.high) })}
            </p>
          </section>
        )}
        <p className="hint">{t("forecast.factors")}</p>
      </div>
    </details>
  );
}
