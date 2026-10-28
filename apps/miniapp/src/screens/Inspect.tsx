import { useEffect, useMemo, useState } from "react";
import { INSPECTION_MINUTES, inspectionChecklist, type CheckCategory } from "@ishonch/shared/client";
import { Icon } from "../components/Icon";
import { useLang, useT } from "../i18n";
import { readPref, writePref } from "../prefs";
import { haptic } from "../telegram";

const TOTAL_MS = INSPECTION_MINUTES * 60_000;
const RADIUS = 54;
const CIRC = 2 * Math.PI * RADIUS;

interface Saved {
  /** When the timer was started (ms); null before. */
  start: number | null;
  /** Indexes of the checked items. */
  done: number[];
}

function read(key: string): Saved {
  try {
    const v = JSON.parse(readPref(key) ?? "null") as Saved | null;
    if (v && Array.isArray(v.done)) return { start: typeof v.start === "number" ? v.start : null, done: v.done.filter((n) => Number.isInteger(n)) };
  } catch {
    /* damaged value: start over */
  }
  return { start: null, done: [] };
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * «Осмотр при получении»: the buyer's 10 minutes at handover as a screen — a countdown and the category's
 * checklist to tick off. Ishonch changes no status here and moves no money: it only helps the buyer not to forget
 * a step; the decision ("беру" / "не беру") is told to the courier. Progress is kept on the device per listing.
 */
export function Inspect({ category, listingId, title }: { category: CheckCategory; listingId?: string; title?: string }) {
  const t = useT();
  const lang = useLang();
  const items = useMemo(() => inspectionChecklist(lang, category), [lang, category]);
  const key = `inspect.${listingId ?? `demo-${category}`}`;
  const [saved, setSaved] = useState<Saved>(() => read(key));
  const [now, setNow] = useState(() => Date.now());
  const running = saved.start !== null;
  const left = running ? TOTAL_MS - (now - saved.start!) : TOTAL_MS;
  const over = running && left <= 0;

  useEffect(() => {
    if (!running || over) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running, over]);
  useEffect(() => {
    if (over) haptic("warning");
  }, [over]);

  const update = (next: Saved) => {
    setSaved(next);
    writePref(key, JSON.stringify(next));
  };
  const start = () => {
    haptic("medium");
    setNow(Date.now());
    update({ ...saved, start: Date.now() });
  };
  const toggle = (i: number) => {
    haptic("selection");
    update({ ...saved, done: saved.done.includes(i) ? saved.done.filter((x) => x !== i) : [...saved.done, i] });
  };
  const reset = () => update({ start: null, done: [] });

  const done = saved.done.filter((i) => i < items.length).length;
  const allDone = done === items.length && items.length > 0;
  const progress = running ? Math.max(0, Math.min(1, left / TOTAL_MS)) : 1;
  const urgent = running && left < 60_000;

  return (
    <div className="stack inspect" data-testid="inspect">
      <header className="how-head">
        <span className="how-badge">
          <Icon name="timer" /> {t("how.minutes", { min: INSPECTION_MINUTES })}
        </span>
        <h1>{t("inspect.title")}</h1>
        <p className="hint">{title ? `${title}. ` : ""}{t("inspect.intro")}</p>
      </header>

      <section className={urgent ? "timer-card urgent" : "timer-card"} data-testid="inspect-timer">
        <svg viewBox="0 0 120 120" className="timer-ring" aria-hidden>
          <circle cx="60" cy="60" r={RADIUS} className="timer-track" />
          <circle cx="60" cy="60" r={RADIUS} className="timer-arc" strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - progress)} transform="rotate(-90 60 60)" />
        </svg>
        <div className="timer-body">
          <strong className="timer-time" data-testid="inspect-time">
            {over ? "0:00" : clock(left)}
          </strong>
          <span className="hint">{over ? t("inspect.over") : running ? t("inspect.running") : t("inspect.ready")}</span>
        </div>
      </section>

      {!running ? (
        <button className="primary" onClick={start} data-testid="inspect-start">
          {t("inspect.start")}
        </button>
      ) : (
        <button className="link" onClick={reset} data-testid="inspect-reset">
          {t("inspect.reset")}
        </button>
      )}

      <section className="card stack" data-testid="inspect-checklist">
        <div className="row between">
          <h3>{t("how.checklist_title", { min: INSPECTION_MINUTES })}</h3>
          <span className={allDone ? "pill ok" : "pill"} data-testid="inspect-progress">
            {t("inspect.progress", { done, total: items.length })}
          </span>
        </div>
        <ul className="plain inspect-list">
          {items.map((line, i) => {
            const on = saved.done.includes(i);
            return (
              <li key={line}>
                <button className={on ? "inspect-row on" : "inspect-row"} aria-pressed={on} onClick={() => toggle(i)} data-testid="inspect-item">
                  <span className="inspect-box" aria-hidden>
                    {on && <Icon name="check" />}
                  </span>
                  <span>{line}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <p className={allDone ? "hint-card verdict-ok" : "hint-card"} data-testid="inspect-verdict">
        <Icon name={allDone ? "ok" : "alert"} /> {allDone ? t("inspect.all_ok") : over ? t("inspect.over_not_ok") : t("inspect.not_ok")}
      </p>
      {!listingId && <p className="hint center">{t("inspect.demo_note")}</p>}
    </div>
  );
}
