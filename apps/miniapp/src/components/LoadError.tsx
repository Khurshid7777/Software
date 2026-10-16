import { useT } from "../i18n";

/** A failed load is never shown as "empty": say so and offer to try again. */
export function LoadError({ onRetry, text }: { onRetry: () => void; text?: string }) {
  const t = useT();
  return (
    <div className="empty" data-testid="load-error">
      <span className="empty-icon" aria-hidden>
        📡
      </span>
      <p className="hint">{text ?? t("common.load_error")}</p>
      <button className="secondary" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </div>
  );
}
