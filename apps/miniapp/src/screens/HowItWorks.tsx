import { useState } from "react";
import { GUARANTEE_DAYS, INSPECTION_MINUTES, inspectionChecklist, type CheckCategory } from "@ishonch/shared/client";
import { Icon, type IconName } from "../components/Icon";
import { useLang, useT } from "../i18n";
import { CATEGORY_ICONS } from "./Home";

const CATEGORIES = Object.keys(CATEGORY_ICONS) as CheckCategory[];

/**
 * «Как проходит проверка»: the promise behind every card, step by step. Ishonch connects the two sides and
 * holds no money: the buyer checks the item for INSPECTION_MINUTES at handover and pays the seller only then.
 */
export function HowItWorks({ category, onCatalog, onTry }: { category?: CheckCategory; onCatalog: () => void; onTry?: (category: CheckCategory) => void }) {
  const t = useT();
  const lang = useLang();
  const [cat, setCat] = useState<CheckCategory>(category && CATEGORIES.includes(category) ? category : "smartphone");
  const steps: Array<{ icon: IconName; title: string; text: string }> = [
    { icon: "chat", title: t("how.step1.title"), text: t("how.step1.text") },
    { icon: "timer", title: t("how.step2.title", { min: INSPECTION_MINUTES }), text: t("how.step2.text") },
    { icon: "undo", title: t("how.step3.title"), text: t("how.step3.text") },
    { icon: "shield", title: t("how.step4.title", { days: GUARANTEE_DAYS }), text: t("how.step4.text") },
  ];
  const before: Array<{ icon: IconName; text: string }> = [
    { icon: "doc", text: t("how.before.passport") },
    { icon: "video", text: t("how.before.video") },
    { icon: "lock", text: t("how.before.imei") },
    { icon: "verify", text: t("how.before.moderation") },
  ];
  return (
    <div className="stack how" data-testid="how">
      <header className="how-head">
        <span className="how-badge">
          <Icon name="timer" /> {t("how.minutes", { min: INSPECTION_MINUTES })}
        </span>
        <h1>{t("how.title")}</h1>
        <p className="hint">{t("how.subtitle")}</p>
      </header>

      <ol className="how-steps">
        {steps.map((s, i) => (
          <li key={s.title} className="how-step">
            <span className="how-num" aria-hidden>
              {i + 1}
            </span>
            <span className="how-step-body">
              <strong>
                <Icon name={s.icon} /> {s.title}
              </strong>
              <span className="hint">{s.text}</span>
            </span>
          </li>
        ))}
      </ol>

      <section className="stack-tight" data-testid="how-vs">
        <h3>{t("vs.title")}</h3>
        <div className="vs-table" role="table">
          <div className="vs-head" role="row">
            <span role="columnheader">{t("vs.board")}</span>
            <span role="columnheader" className="vs-us">
              {t("vs.ishonch")}
            </span>
          </div>
          {(["photo", "video", "check", "stolen", "compare", "money"] as const).map((k) => (
            <div className="vs-row" role="row" key={k}>
              <span role="cell" className="vs-board">
                <Icon name="close" /> {t(`vs.${k}.board`)}
              </span>
              <span role="cell" className="vs-us">
                <Icon name="check" /> {t(`vs.${k}.ishonch`)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="card stack" data-testid="how-checklist">
        <h3>{t("how.checklist_title", { min: INSPECTION_MINUTES })}</h3>
        <div className="chips scroll-x bleed">
          {CATEGORIES.map((c) => (
            <button key={c} className={c === cat ? "chip active" : "chip"} onClick={() => setCat(c)}>
              {t(`category.${c}`)}
            </button>
          ))}
        </div>
        {onTry && (
          <button className="secondary" onClick={() => onTry(cat)} data-testid="how-try">
            <Icon name="timer" /> {t("how.try")}
          </button>
        )}
        <ul className="plain how-checklist">
          {inspectionChecklist(lang, cat).map((line) => (
            <li key={line}>
              <Icon name="check" /> {line}
            </li>
          ))}
        </ul>
      </section>

      <section className="stack-tight">
        <h3>{t("how.before_title")}</h3>
        <ul className="plain how-before">
          {before.map((b) => (
            <li key={b.text}>
              <span className="tile-icon" aria-hidden>
                <Icon name={b.icon} />
              </span>
              <span>{b.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <button className="primary" onClick={onCatalog} data-testid="how-catalog">
        {t("how.cta")}
      </button>
    </div>
  );
}
