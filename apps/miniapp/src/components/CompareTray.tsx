import { COMPARE_MAX } from "@ishonch/shared/client";
import { clearCompare, useCompare } from "../compare";
import { useT } from "../i18n";
import { Icon } from "./Icon";

/** Floating «Сравнить (N)» above the tab bar while the buyer collects listings; hidden on the compare screen itself. */
export function CompareTray({ onOpen, withTabbar }: { onOpen: () => void; withTabbar: boolean }) {
  const t = useT();
  const ids = useCompare();
  if (!ids.length) return null;
  return (
    <div className={withTabbar ? "compare-tray above-tabbar" : "compare-tray"} data-testid="compare-tray">
      <button className="compare-tray-main" onClick={onOpen} data-testid="compare-tray-open">
        <Icon name="compare" />
        <span>{t("versus.open", { n: ids.length })}</span>
        <span className="compare-dots" aria-hidden>
          {Array.from({ length: COMPARE_MAX }, (_, i) => (
            <i key={i} className={i < ids.length ? "on" : ""} />
          ))}
        </span>
      </button>
      <button className="compare-tray-clear" aria-label={t("versus.clear")} onClick={clearCompare} data-testid="compare-tray-clear">
        <Icon name="close" />
      </button>
    </div>
  );
}
