import type { OrderDto, OrderStatus } from "@ishonch/shared/client";
import { useT } from "../i18n";
import { Icon } from "./Icon";

const STEPS = ["new", "confirmed", "courier_assigned", "picked_up", "delivered"] as const satisfies readonly OrderStatus[];

/**
 * Where the order is and what happens next, in one glance: five steps, the current one marked, and a sentence
 * for this person's role (the buyer is told what to do at the door, the seller what to prepare). A refused or
 * cancelled order shows its end state instead of the steps.
 */
export function OrderTrack({ order: o }: { order: Pick<OrderDto, "status" | "role"> }) {
  const t = useT();
  const role = o.role === "seller" ? "seller" : "buyer";
  if (o.status === "cancelled" || o.status === "returned") {
    return (
      <p className="hint-card" data-testid="order-next">
        {t(`order.next.${role}.${o.status}`)}
      </p>
    );
  }
  const at = (STEPS as readonly OrderStatus[]).indexOf(o.status);
  return (
    <div className="order-track" data-testid="order-track">
      <ol className="track-steps" aria-label={t("order.track")}>
        {STEPS.map((s, i) => (
          <li key={s} className={i < at ? "done" : i === at ? "now" : ""} aria-current={i === at ? "step" : undefined}>
            <span className="track-dot" aria-hidden>
              {i < at || (i === at && s === "delivered") ? <Icon name="check" /> : i + 1}
            </span>
            <span className="track-label">{t(`order.step.${s}`)}</span>
          </li>
        ))}
      </ol>
      <p className="track-next" data-testid="order-next">
        {t(`order.next.${role}.${o.status}`)}
      </p>
    </div>
  );
}
