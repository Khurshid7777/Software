import { useT } from "../i18n";
import { haptic } from "../telegram";

export const TABS = ["home", "catalog", "sell", "orders", "profile"] as const;
export type Tab = (typeof TABS)[number];
const ICONS: Record<Tab, string> = { home: "🏠", catalog: "🛍️", sell: "➕", orders: "📦", profile: "👤" };

/** Bottom navigation on the top-level screens (detail screens use Telegram's Back button). */
export function TabBar({ active, onSelect, badges = {} }: { active: Tab | null; onSelect: (t: Tab) => void; badges?: Partial<Record<Tab, number>> }) {
  const t = useT();
  return (
    <nav className="tabbar" aria-label="menu">
      {TABS.map((tab) => (
        <button
          key={tab}
          className={tab === active ? "active" : ""}
          aria-current={tab === active ? "page" : undefined}
          onClick={() => {
            haptic("selection");
            onSelect(tab);
          }}
          data-testid={`tab-${tab}`}
        >
          <span className={tab === "sell" ? "tab-icon tab-sell" : "tab-icon"} aria-hidden>
            {ICONS[tab]}
            {!!badges[tab] && <span className="tab-badge">{badges[tab]}</span>}
          </span>
          <span className="tab-label">{t(`tab.${tab}`)}</span>
        </button>
      ))}
    </nav>
  );
}
