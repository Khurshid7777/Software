import { useState } from "react";
import { BIOMETRICS_STATES, KIT_ITEMS, REPAIR_KINDS, type ConditionChecklist } from "@ishonch/shared/client";
import { useT } from "../i18n";

const toggle = <T,>(list: T[] | undefined, v: T) => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v]);

/** Seller: battery, Face ID / Touch ID, repairs and kit as taps instead of free text. */
export function ChecklistEditor({ value: initial, onSave: save }: { value: ConditionChecklist; onSave: (c: ConditionChecklist) => void }) {
  const t = useT();
  // Local copy: quick taps build on each other instead of on a value still being saved.
  const [value, setValue] = useState(initial);
  const onSave = (next: ConditionChecklist) => {
    setValue(next);
    save(next);
  };
  return (
    <fieldset className="field stack" data-testid="checklist-editor">
      <legend>{t("checklist.title")}</legend>
      <label className="field">
        {t("checklist.battery_label")}
        <input
          inputMode="numeric"
          placeholder="87"
          maxLength={3}
          defaultValue={value.batteryPct ?? ""}
          onBlur={(e) => {
            const n = Number(e.target.value.replace(/\D/g, ""));
            const batteryPct = n >= 1 && n <= 100 ? n : undefined;
            if (batteryPct !== value.batteryPct) onSave({ ...value, batteryPct });
          }}
          data-testid="checklist-battery"
        />
        <span className="hint">{t("checklist.battery_hint")}</span>
      </label>
      <span>{t("checklist.biometrics_label")}</span>
      <div className="chips">
        {BIOMETRICS_STATES.map((b) => (
          <button
            key={b}
            className={value.biometrics === b ? "chip active" : "chip"}
            onClick={() => onSave({ ...value, biometrics: value.biometrics === b ? undefined : b })}
          >
            {t(`checklist.biometrics.${b}`)}
          </button>
        ))}
      </div>
      <span>{t("checklist.repairs_label")}</span>
      <div className="chips">
        {REPAIR_KINDS.map((r) => (
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
            {t(`checklist.repairs.${r}`)}
          </button>
        ))}
      </div>
      <span>{t("checklist.kit_label")}</span>
      <div className="chips">
        {KIT_ITEMS.map((k) => (
          <button key={k} className={value.kit?.includes(k) ? "chip active" : "chip"} onClick={() => onSave({ ...value, kit: toggle(value.kit, k) })}>
            {t(`checklist.kit.${k}`)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Buyer: the filled part of the checklist as a short list; nothing when it is empty. */
export function ChecklistView({ value }: { value: ConditionChecklist }) {
  const t = useT();
  const rows: string[] = [];
  if (value.batteryPct != null) rows.push(`🔋 ${t("checklist.battery", { pct: value.batteryPct })}`);
  if (value.biometrics) rows.push(`🔒 ${t("checklist.biometrics_label")}: ${t(`checklist.biometrics.${value.biometrics}`)}`);
  if (value.repairs?.length) rows.push(`🛠 ${t("checklist.repairs_label")}: ${value.repairs.map((r) => t(`checklist.repairs.${r}`)).join(", ")}`);
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
