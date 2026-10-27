import type { ReactNode } from "react";

/** Empty state with a way forward: an icon (or an illustration), one sentence and (usually) the next step. */
export function Empty({ icon, image, title, text, action }: { icon: string; image?: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty" data-testid="empty">
      {image ? (
        <img className="empty-art" src={image} alt="" width={168} height={168} />
      ) : (
        <span className="empty-icon" aria-hidden>
          {icon}
        </span>
      )}
      <strong>{title}</strong>
      {text && <p className="hint">{text}</p>}
      {action}
    </div>
  );
}
