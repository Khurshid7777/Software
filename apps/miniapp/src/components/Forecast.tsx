import { useEffect, useId, useState } from "react";
import { FORECAST_YEARS, USAGE_LEVELS, forecastDevice, formatUzs, type DeviceForecast, type ListingDto } from "@ishonch/shared/client";
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

/** «3,9 млн» instead of «3 900 000 UZS»: for axes, legends and tiles where room is tight. */
export function useCompactUzs() {
  const t = useT();
  return (v: number) => {
    if (v >= 100_000) return t("forecast.mln", { n: (Math.round(v / 100_000) / 10).toString().replace(".", ",") });
    return v >= 1000 ? `${Math.round(v / 1000)} ${t("forecast.thousand")}` : "0";
  };
}

/** Battery health as a ring: green while it is good, amber when a replacement is near, red below that. */
function Gauge({ value, label }: { value: number; label: string }) {
  const r = 19;
  const c = 2 * Math.PI * r;
  const color = value >= 80 ? "var(--ok)" : value >= 65 ? "var(--warn)" : "var(--bad)";
  return (
    <svg className="fc-gauge" viewBox="0 0 48 48" role="img" aria-label={label}>
      <circle cx="24" cy="24" r={r} className="fc-gauge-track" />
      <circle cx="24" cy="24" r={r} className="fc-gauge-fill" style={{ stroke: color, strokeDasharray: `${(c * Math.max(0, Math.min(100, value))) / 100} ${c}` }} transform="rotate(-90 24 24)" />
    </svg>
  );
}

export interface ChartThreshold {
  value: number;
  label: string;
}

/**
 * A line chart over years 0..N (SVG, no library). `max` fixes the top of the scale (100 for a battery); a dashed
 * `threshold` marks where something happens (battery replacement). Touch or move along the chart to read any year;
 * without that, it shows the year the buyer picked (`active`). The legend carries the value for the shown year.
 */
export function MiniChart({
  series,
  max,
  format,
  tick,
  label,
  active,
  threshold,
}: {
  series: ChartSeries[];
  max?: number;
  format: (v: number) => string;
  tick?: (v: number) => string;
  label: string;
  active?: number;
  threshold?: ChartThreshold;
}) {
  const t = useT();
  const gid = useId().replace(/[^a-z0-9]/gi, "");
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setHover(null), [active]);

  const W = 320;
  const H = 196;
  const pad = { l: 40, r: 16, t: 16, b: 26 };
  const n = Math.max(...series.map((s) => s.values.length)) - 1;
  const all = series.flatMap((s) => [...s.values, ...(s.low ?? []), ...(s.high ?? [])]);
  const bottom = max != null ? Math.max(0, Math.min(75, Math.floor((Math.min(...all, threshold?.value ?? 100) - 8) / 25) * 25)) : 0;
  const step = max != null ? 25 : niceStep(Math.max(...all) * 1.04);
  const top = max ?? step * 3;
  const x = (i: number) => pad.l + (i / Math.max(n, 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (Math.min(Math.max(v, bottom), top) - bottom) / (top - bottom)) * (H - pad.t - pad.b);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const at = Math.min(hover ?? active ?? n, n);
  const single = series.length === 1;
  const fmtTick = tick ?? format;
  const ticks = Array.from({ length: Math.round((top - bottom) / step) + 1 }, (_, k) => bottom + step * k);
  const xLabel = (i: number) => (i === 0 ? t("forecast.now") : t("forecast.years", { n: i }));
  const desc = series.map((s) => `${s.label}: ${s.values.map(format).join(" → ")}`).join("; ");

  function scrub(e: React.PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(n, Math.round(((vx - pad.l) / (W - pad.l - pad.r)) * n))));
  }

  return (
    <figure className="mini-chart" data-testid="forecast-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}. ${desc}`}
        onPointerDown={scrub}
        onPointerMove={scrub}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
      >
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${gid}-${s.key.replace(/[^a-z0-9]/gi, "")}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: s.color, stopOpacity: 0.3 }} />
              <stop offset="1" style={{ stopColor: s.color, stopOpacity: 0 }} />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="chart-grid" />
            <text x={pad.l - 6} y={y(v) + 3.5} textAnchor="end" className="chart-axis">
              {fmtTick(v)}
            </text>
          </g>
        ))}
        {threshold && threshold.value > bottom && threshold.value < top && (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={y(threshold.value)} y2={y(threshold.value)} className="chart-threshold" />
            <text x={pad.l + 4} y={y(threshold.value) - 4} className="chart-threshold-label">
              {threshold.label}
            </text>
          </g>
        )}
        {series.map((s) =>
          s.low && s.high ? (
            <path
              key={`${s.key}-band`}
              d={`${path(s.high)} L${x(s.high.length - 1).toFixed(1)} ${y(s.low[s.low.length - 1]!).toFixed(1)} ${[...s.low].reverse().map((v, i) => `L${x(s.low!.length - 1 - i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")} Z`}
              fill={s.color}
              fillOpacity={0.14}
              stroke="none"
            />
          ) : null,
        )}
        {single && series[0] && !series[0].low && (
          <path d={`${path(series[0].values)} L${x(n).toFixed(1)} ${y(bottom).toFixed(1)} L${x(0).toFixed(1)} ${y(bottom).toFixed(1)} Z`} fill={`url(#${gid}-${series[0].key.replace(/[^a-z0-9]/gi, "")})`} stroke="none" />
        )}
        <line x1={x(at)} x2={x(at)} y1={pad.t - 4} y2={H - pad.b} className="chart-guide" />
        {series.map((s) => (
          <path key={s.key} d={path(s.values)} pathLength={1} className="chart-line" fill="none" stroke={s.color} strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {series.map((s) =>
          s.values.map((v, i) => (
            <circle key={`${s.key}-${i}`} cx={x(i)} cy={y(v)} r={i === at ? 5.5 : 2.6} fill={i === at ? s.color : "var(--surface)"} stroke={s.color} strokeWidth={i === at ? 2.5 : 1.8} className={i === at ? "chart-dot-active" : undefined} />
          )),
        )}
        {single && series[0] && (() => {
          const v = series[0].values[at]!;
          const text = format(v);
          const w = text.length * 6.6 + 16;
          const cx = Math.min(Math.max(x(at), pad.l + w / 2 - 4), W - pad.r - w / 2 + 4);
          const py = y(v);
          const by = py - 34 < 0 ? py + 12 : py - 34;
          return (
            <g className="chart-bubble" aria-hidden>
              <rect x={cx - w / 2} y={by} width={w} height={22} rx={11} />
              <text x={cx} y={by + 15} textAnchor="middle">
                {text}
              </text>
            </g>
          );
        })()}
        {Array.from({ length: n + 1 }, (_, i) => (
          <text key={i} x={x(i)} y={H - 7} textAnchor={i === 0 ? "start" : i === n ? "end" : "middle"} className={i === at ? "chart-axis chart-axis-active" : "chart-axis"}>
            {xLabel(i)}
          </text>
        ))}
      </svg>
      <figcaption className="chart-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} aria-hidden /> {s.label}
            {!single && <strong>{format(s.values[at]!)}</strong>}
          </span>
        ))}
      </figcaption>
      <p className="hint chart-hint">{t("forecast.chart_hint")}</p>
    </figure>
  );
}

/** A round step so that three of them cover `v` (8 200 000 → 3 000 000): the price scale gets 0, 3, 6, 9 million. */
function niceStep(v: number) {
  const raw = Math.max(v, 1) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 1.5, 2, 3, 4, 5, 10].map((m) => m * mag).find((x) => x >= raw) ?? raw);
}

/** When things happen over the horizon: a battery swap and each service task, as dots on a time line. */
function Timeline({ f, rows }: { f: DeviceForecast; rows: Array<{ key: string; label: string; sub: string; at: number[] }> }) {
  const t = useT();
  const months = f.years * 12;
  return (
    <div className="fc-timeline" style={{ ["--years" as string]: f.years }}>
      {rows.map((r) => (
        <div key={r.key} className="fc-row" data-testid={`forecast-task-${r.key}`}>
          <span className="fc-row-head">
            <Icon name="wrench" />
            <span>
              <strong>{r.label}</strong>
              <span className="hint">{r.sub}</span>
            </span>
          </span>
          <span className="fc-track" aria-hidden>
            {r.at.map((m, i) => (
              <i key={m} className={i === 0 ? "fc-dot first" : "fc-dot"} style={{ left: `${(m / months) * 100}%` }} />
            ))}
          </span>
        </div>
      ))}
      <div className="fc-axis" aria-hidden>
        {Array.from({ length: f.years + 1 }, (_, i) => (
          <span key={i} style={{ left: `${(i / f.years) * 100}%` }}>
            {i === 0 ? t("forecast.now") : t("forecast.years", { n: i })}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * «Что будет с устройством»: battery, service and price over the next years, for the use the buyer chooses.
 * Everything is a rough estimate from typical values for the category, and the card says so before the numbers.
 */
export function ForecastCard({ listing }: { listing: ListingDto }) {
  const t = useT();
  const money = useCompactUzs();
  const [settings, set] = useForecastSettings();
  const f = forecastDevice(forecastInput(listing), settings.usage, settings.years);
  const last = f.price?.series[f.price.series.length - 1];
  const months = f.years * 12;
  const bat = f.battery;
  const batNow = bat ? Math.round(bat.series[0]!) : 0;
  const batLater = bat ? Math.round(bat.series[f.years]!) : 0;
  const priceNow = f.price?.series[0]?.mid ?? 0;
  const priceDelta = last && priceNow ? Math.round(((last.mid - priceNow) / priceNow) * 100) : 0;

  const rows = [
    ...(bat && bat.replaceInMonths <= months
      ? [{ key: "battery", label: t("forecast.tile.replace"), sub: bat.replaceInMonths === 0 ? t("forecast.tile.replace_now") : t("forecast.tile.replace_in", { months: bat.replaceInMonths }), at: [bat.replaceInMonths] }]
      : []),
    ...f.maintenance.map((m) => {
      const at: number[] = [];
      for (let k = m.inMonths; k <= months && at.length < 12; k += Math.max(m.everyMonths, 1)) at.push(k);
      return { key: m.key, label: t(`forecast.maint.${m.key}`), sub: t("forecast.maint_when", { months: m.inMonths, every: m.everyMonths }), at };
    }),
  ];

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

        <div className="fc-tiles" data-testid="forecast-tiles">
          {bat && (
            <div className="fc-tile">
              <span className="fc-tile-label">{t("forecast.tile.battery", { n: f.years })}</span>
              <span className="fc-tile-main">
                <Gauge value={batLater} label={`${batLater}%`} />
                <strong>{batLater}%</strong>
              </span>
              <span className="hint">{t("forecast.tile.now", { pct: batNow })}</span>
            </div>
          )}
          {bat && (
            <div className="fc-tile">
              <span className="fc-tile-label">{t("forecast.tile.replace")}</span>
              <span className="fc-tile-main">
                <strong>{bat.replaceInMonths === 0 ? t("forecast.tile.replace_now") : t("forecast.tile.replace_val", { months: bat.replaceInMonths })}</strong>
              </span>
              <span className="hint">{t("forecast.tile.replace_sub", { pct: bat.threshold })}</span>
            </div>
          )}
          {last && (
            <div className="fc-tile">
              <span className="fc-tile-label">{t("forecast.tile.price", { n: f.years })}</span>
              <span className="fc-tile-main">
                <strong>{money(last.mid)}</strong>
              </span>
              <span className="hint">{t("forecast.tile.price_sub", { pct: `${priceDelta > 0 ? "+" : "−"}${Math.abs(priceDelta)}` })}</span>
            </div>
          )}
        </div>

        {bat && (
          <section className="stack-tight" data-testid="forecast-battery">
            <h2 className="h-sub">{t("forecast.battery")}</h2>
            <MiniChart
              label={t("forecast.battery")}
              max={100}
              active={f.years}
              format={(v) => `${Math.round(v)}%`}
              threshold={{ value: bat.threshold, label: t("forecast.threshold", { pct: bat.threshold }) }}
              series={[{ key: "b", label: t("forecast.battery_series"), color: "var(--brand-fg)", values: bat.series }]}
            />
            <p className="forecast-line">
              {t("forecast.battery_after", { n: f.years, pct: batLater })}
              {bat.estimated && <span className="hint"> {t("forecast.battery_estimated", { pct: Math.round(bat.start) })}</span>}
            </p>
            <p className="forecast-line" data-testid="forecast-replace">
              {bat.replaceInMonths === 0 ? t("forecast.replace_now", { pct: bat.threshold }) : t("forecast.replace_in", { months: bat.replaceInMonths, pct: bat.threshold })}
            </p>
          </section>
        )}

        <section className="stack-tight" data-testid="forecast-service">
          <h2 className="h-sub">{t("forecast.service")}</h2>
          {rows.length === 0 ? <p className="hint">{t("forecast.service_none")}</p> : <Timeline f={f} rows={rows} />}
        </section>

        {f.price && last && (
          <section className="stack-tight" data-testid="forecast-price">
            <h2 className="h-sub">{t("forecast.price")}</h2>
            <MiniChart
              label={t("forecast.price")}
              active={f.years}
              format={money}
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
