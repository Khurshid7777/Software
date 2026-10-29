import { IMEI_CATEGORIES, checklistFields, videoRequiredFor, type ChecklistField, type ListingDto } from "@ishonch/shared/client";
import { useT } from "../i18n";
import { Icon } from "./Icon";

interface Step {
  key: string;
  done: boolean;
  /** What to do, shown while it is not done. */
  todo: string;
  /** Required steps come first and are marked. */
  required?: boolean;
}

const FIELD_DONE: Record<ChecklistField, (l: ListingDto) => boolean> = {
  accountUnlocked: (l) => l.checklist.accountUnlocked != null,
  batteryPct: (l) => l.checklist.batteryPct != null,
  biometrics: (l) => !!l.checklist.biometrics,
  repairs: (l) => !!l.checklist.repairs?.length,
  kit: (l) => !!l.checklist.kit?.length,
  mining: (l) => !!l.checklist.mining,
  deadPixels: (l) => !!l.checklist.deadPixels,
  ageYears: (l) => l.checklist.ageYears != null,
};

/**
 * «Готовность объявления»: what is still missing for a full passport. Every filled field becomes a green check
 * the buyer sees in the item passport, so the seller sees the same list from their side, with what to do next.
 */
export function Readiness({ listing: l }: { listing: ListingDto }) {
  const t = useT();
  const steps: Step[] = [{ key: "photos", done: l.photos.length >= 3, todo: t("ready.photos", { n: l.photos.length }) }];
  steps.push({ key: "video", done: !!l.video && l.videoCheck?.verdict !== "fail", required: videoRequiredFor(l.category), todo: t("ready.video") });
  if ((IMEI_CATEGORIES as readonly string[]).includes(l.category)) steps.push({ key: "imei", done: !!l.imeiTail, todo: t("ready.imei") });
  for (const f of checklistFields(l.category)) steps.push({ key: f, done: FIELD_DONE[f](l), todo: t(`ready.field.${f}`) });
  const done = steps.filter((s) => s.done).length;
  const pct = Math.round((done / steps.length) * 100);
  const missing = steps.filter((s) => !s.done).sort((a, b) => Number(!!b.required) - Number(!!a.required));
  return (
    <section className="card stack readiness" data-testid="readiness">
      <div className="row between">
        <h3>{t("ready.title")}</h3>
        <span className={missing.length ? "pill" : "pill ok"} data-testid="readiness-count">
          {done} / {steps.length}
        </span>
      </div>
      <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {missing.length === 0 ? (
        <p className="hint" data-testid="readiness-done">
          <Icon name="ok" /> {t("ready.all")}
        </p>
      ) : (
        <ul className="plain stack-tight">
          {missing.map((s) => (
            <li key={s.key} className="ready-todo" data-testid={`ready-${s.key}`}>
              <Icon name={s.required ? "alert" : "plus"} />
              <span>
                {s.todo}
                {s.required && <span className="tag tag-required">{t("ready.required")}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
