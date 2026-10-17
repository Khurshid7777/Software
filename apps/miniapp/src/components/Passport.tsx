import { useState } from "react";
import { GRADES, formatUzs, type CheckStatus, type Grade, type ItemPassport } from "@ishonch/shared/client";
import { useLang, useT } from "../i18n";

const ICON: Record<CheckStatus, string> = { ok: "✅", warn: "⚠️", fail: "⛔", unknown: "○" };

/** Condition grade letter; used on cards, in the passport and in the "what is a grade" sheet. */
export function GradeChip({ grade, size = "sm" }: { grade: Grade; size?: "sm" | "lg" }) {
  return (
    <span className={`grade grade-${grade} grade-${size}`} data-testid="grade-chip">
      {grade}
    </span>
  );
}

/**
 * «Паспорт товара»: one summary line (grade + "N of M checks"), the list of checks with who confirmed
 * each one, the reasons the grade was lowered and the device's history on Ishonch. Collapsed by default.
 */
export function Passport({ passport: p }: { passport: ItemPassport }) {
  const t = useT();
  const lang = useLang();
  const [open, setOpen] = useState(false);
  const [explain, setExplain] = useState(false);
  const date = (iso: string) => new Date(iso).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ", { month: "short", year: "numeric" });

  return (
    <section className="card stack passport" data-testid="passport">
      <button className="passport-head" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="passport-toggle">
        {p.grade && <GradeChip grade={p.grade} size="lg" />}
        <span className="stack-tight">
          <strong>
            {t("passport.title")}
            {p.grade && ` · ${t("passport.grade", { grade: p.grade })} — ${t(`passport.grade_name.${p.grade}`)}`}
          </strong>
          <span className="hint" data-testid="passport-summary">
            {t("passport.summary", { passed: p.passed, total: p.total })}
          </span>
        </span>
        <span aria-hidden>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <>
          {p.reasons.length > 0 && (
            <p className="hint" data-testid="passport-reasons">
              {t("passport.lowered", { reasons: p.reasons.map((r) => t(`passport.reason.${r}`)).join(", ") })}
            </p>
          )}
          {p.grade && (
            <button className="link" onClick={() => setExplain(!explain)} data-testid="grade-explain">
              {t("passport.what_grade")}
            </button>
          )}
          {explain && (
            <ul className="plain grade-legend" data-testid="grade-legend">
              {GRADES.map((g) => (
                <li key={g} className={g === p.grade ? "current" : ""}>
                  <GradeChip grade={g} /> <strong>{t(`passport.grade_name.${g}`)}</strong> — {t(`passport.grade_desc.${g}`)}
                </li>
              ))}
              <li className="hint">{t("passport.grade_rule")}</li>
            </ul>
          )}
          <ul className="plain passport-checks">
            {p.checks.map((c) => (
              <li key={c.code} className={`check-${c.status}`} data-testid={`passport-${c.code}`}>
                <span aria-hidden>{ICON[c.status]}</span>
                <span>
                  {t(`passport.check.${c.code}.${c.status}` as "passport.check.photos.ok", c.params)}
                  <span className="hint"> · {t(`passport.source.${c.source}`)}</span>
                </span>
              </li>
            ))}
          </ul>
          {p.history && (
            <div className="stack-tight" data-testid="passport-history">
              <h3>{t("passport.history")}</h3>
              <span className="hint">{t("passport.history_text", { n: p.history.listings, sold: p.history.sold })}</span>
              {p.history.prices.map((h) => (
                <span key={h.at} className="hint">
                  {date(h.at)} — {formatUzs(h.price)}
                </span>
              ))}
              {p.history.inspections.passed + p.history.inspections.failed > 0 && (
                <span className="hint">{t("passport.history_inspections", p.history.inspections)}</span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
