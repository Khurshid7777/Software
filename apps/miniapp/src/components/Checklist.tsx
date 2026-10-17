import { useState } from "react";
import {
  BIOMETRICS_STATES,
  MINING_STATES,
  PIXEL_STATES,
  checklistFields,
  kitItems,
  repairKinds,
  type ConditionChecklist,
} from "@ishonch/shared/client";
import { useT } from "../i18n";

/** Phones list repair kinds; for other categories the only kind is "some repair". */
const repairText = (t: ReturnType<typeof useT>, category: string, r: string) =>
  r === "other" && !repairKinds(category).includes("screen") ? t("checklist.repairs.any") : t(`checklist.repairs.${r}` as "checklist.repairs.none");

const toggle = <T,>(list: T[] | undefined, v: T) => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]);

/** A row of chips where one value (or none) is picked; a second tap clears it. */
function OneOf<V extends string>({ label, values, value, text, onPick, testId }: {
  label: string;
  values: readonly V[];
  value: V | undefined;
  text: (v: V) => string;
  onPick: (v: V | undefined) => void;
  testId: string;
}) {
  return (
    <>
      <span>{label}</span>
      <div className="chips">
        {values.map((v) => (
          <button key={v} className={value === v ? "chip active" : "chip"} onClick={() => onPick(value === v ? undefined : v)} data-testid={`${testId}-${v}`}>
            {text(v)}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Seller: the category's condition facts as taps instead of free text — battery and Face ID for phones,
 * mining for PC parts, dead pixels for monitors, age for everything that wears out.
 */
export function ChecklistEditor({ category, value: initial, onSave: save }: { category: string; value: ConditionChecklist; onSave: (c: ConditionChecklist) => void }) {
  const t = useT();
  // Local copy: quick taps build on each other instead of on a value still being saved.
  const [value, setValue] = useState(initial);
  const fields = checklistFields(category);
  if (!fields.length) return null;
  const onSave = (next: ConditionChecklist) => {
    setValue(next);
    save(next);
  };
  const number = (raw: string, min: number, max: number) => {
    const digits = raw.replace(/\D/g, "");
    const n = Number(digits);
    return digits && n >= min && n <= max ? n : undefined;
  };
  return (
    <fieldset className="field stack" data-testid="checklist-editor">
      <legend>{t("checklist.title")}</legend>
      {fields.includes("accountUnlocked") && (
        <>
          <OneOf
            label={t("checklist.account_label")}
            values={["yes", "no"] as const}
            value={value.accountUnlocked == null ? undefined : value.accountUnlocked ? "yes" : "no"}
            text={(v) => t(`checklist.account.${v}`)}
            onPick={(v) => onSave({ ...value, accountUnlocked: v == null ? undefined : v === "yes" })}
            testId="checklist-account"
          />
          <span className="hint">{t("checklist.account_hint")}</span>
        </>
      )}
      {fields.includes("batteryPct") && (
        <label className="field">
          {t("checklist.battery_label")}
          <input
            inputMode="numeric"
            placeholder="87"
            maxLength={3}
            defaultValue={value.batteryPct ?? ""}
            onBlur={(e) => {
              const batteryPct = number(e.target.value, 1, 100);
              if (batteryPct !== value.batteryPct) onSave({ ...value, batteryPct });
            }}
            data-testid="checklist-battery"
          />
          <span className="hint">{t("checklist.battery_hint")}</span>
        </label>
      )}
      {fields.includes("biometrics") && (
        <OneOf
          label={t("checklist.biometrics_label")}
          values={BIOMETRICS_STATES}
          value={value.biometrics}
          text={(b) => t(`checklist.biometrics.${b}`)}
          onPick={(biometrics) => onSave({ ...value, biometrics })}
          testId="checklist-biometrics"
        />
      )}
      {fields.includes("mining") && (
        <OneOf
          label={t("checklist.mining_label")}
          values={MINING_STATES}
          value={value.mining}
          text={(m) => t(`checklist.mining.${m}`)}
          onPick={(mining) => onSave({ ...value, mining })}
          testId="checklist-mining"
        />
      )}
      {fields.includes("deadPixels") && (
        <OneOf
          label={t("checklist.pixels_label")}
          values={PIXEL_STATES}
          value={value.deadPixels}
          text={(p) => t(`checklist.pixels.${p}`)}
          onPick={(deadPixels) => onSave({ ...value, deadPixels })}
          testId="checklist-pixels"
        />
      )}
      {fields.includes("ageYears") && (
        <label className="field">
          {t("checklist.age_label")}
          <input
            inputMode="numeric"
            placeholder="2"
            maxLength={2}
            defaultValue={value.ageYears ?? ""}
            onBlur={(e) => {
              const ageYears = number(e.target.value, 0, 40);
              if (ageYears !== value.ageYears) onSave({ ...value, ageYears });
            }}
            data-testid="checklist-age"
          />
          <span className="hint">{t("checklist.age_hint")}</span>
        </label>
      )}
      {fields.includes("repairs") && (
        <>
          <span>{t("checklist.repairs_label")}</span>
          <div className="chips">
            {repairKinds(category).map((r) => (
              <button
                key={r}
                className={value.repairs?.includes(r) ? "chip active" : "chip"}
                onClick={() => {
                  // "No repairs" and a repair exclude each other.
                  const next = r === "none" ? (value.repairs?.includes("none") ? [] : ["none" as const]) : toggle(value.repairs, r).filter((x) => x !== "none");
                  onSave({ ...value, repairs: next });
                }}
                data-testid={`checklist-repair-${r}`}
              >
                {repairText(t, category, r)}
              </button>
            ))}
          </div>
        </>
      )}
      {fields.includes("kit") && (
        <>
          <span>{t("checklist.kit_label")}</span>
          <div className="chips">
            {kitItems(category).map((k) => (
              <button key={k} className={value.kit?.includes(k) ? "chip active" : "chip"} onClick={() => onSave({ ...value, kit: toggle(value.kit, k) })}>
                {t(`checklist.kit.${k}`)}
              </button>
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}

/** Buyer: the filled part of the checklist as a short list; nothing when it is empty. */
export function ChecklistView({ category, value }: { category: string; value: ConditionChecklist }) {
  const t = useT();
  const rows: string[] = [];
  if (value.accountUnlocked != null) rows.push(value.accountUnlocked ? `🔓 ${t("checklist.account_view_yes")}` : `🔒 ${t("checklist.account_view_no")}`);
  if (value.batteryPct != null) rows.push(`🔋 ${t("checklist.battery", { pct: value.batteryPct })}`);
  if (value.biometrics) rows.push(`🔒 ${t("checklist.biometrics_label")}: ${t(`checklist.biometrics.${value.biometrics}`)}`);
  if (value.mining) rows.push(`⛏ ${t("checklist.mining_label")}: ${t(`checklist.mining.${value.mining}`)}`);
  if (value.deadPixels) rows.push(`🔲 ${t("checklist.pixels_label")}: ${t(`checklist.pixels.${value.deadPixels}`)}`);
  if (value.ageYears != null) rows.push(`📅 ${value.ageYears === 0 ? t("checklist.age_new") : t("checklist.age", { n: value.ageYears })}`);
  if (value.repairs?.length) rows.push(`🛠 ${t("checklist.repairs_label")}: ${value.repairs.map((r) => repairText(t, category, r)).join(", ")}`);
  if (value.kit?.length) rows.push(`📦 ${t("checklist.kit_label")}: ${value.kit.map((k) => t(`checklist.kit.${k}`)).join(", ")}`);
  if (!rows.length) return null;
  return (
    <ul className="plain checklist" data-testid="checklist-view">
      {rows.map((r) => (
        <li key={r}>{r}</li>
      ))}
    </ul>
  );
}
