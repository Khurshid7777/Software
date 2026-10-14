import type { ReactNode } from "react";

/** Empty state with a way forward: an icon, one sentence and (usually) the next step. */
export function Empty({ icon, title, text, action }: { icon: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty" data-testid="empty">
      <span className="empty-icon" aria-hidden>
        {icon}
      </span>
      <strong>{title}</strong>
      {text && <p className="hint">{text}</p>}
      {action}
    </div>
  );
}
