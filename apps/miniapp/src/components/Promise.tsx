import { GUARANTEE_DAYS, INSPECTION_MINUTES } from "@ishonch/shared/client";
import { useT } from "../i18n";
import { Icon } from "./Icon";

/**
 * The buyer's promise, worded the same everywhere: N minutes to check the item at handover, no payment if it
 * does not fit. Tapping it opens «Как проходит проверка». `strip` is the thin catalog banner, `card` the
 * listing / checkout block.
 */
export function BuyerPromise({ onOpen, variant = "card" }: { onOpen?: () => void; variant?: "card" | "strip" }) {
  const t = useT();
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag className={`promise promise-${variant}`} onClick={onOpen} data-testid="promise">
      <span className="promise-icon" aria-hidden>
        <Icon name="timer" />
      </span>
      <span className="promise-text">
        <strong>{t("how.promise", { min: INSPECTION_MINUTES })}</strong>
        {variant === "card" && <span className="hint">{t("how.desc", { min: INSPECTION_MINUTES, days: GUARANTEE_DAYS })}</span>}
      </span>
      {onOpen && (
        <span className="promise-more">
          {variant === "card" ? t("how.promise_link") : ""} <Icon name="chevron" />
        </span>
      )}
    </Tag>
  );
}
