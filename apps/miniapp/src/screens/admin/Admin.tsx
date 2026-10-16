import { useState } from "react";
import type { Api } from "../../api";
import { Dashboard } from "./Dashboard";
import { AuditLog, References, Settings, Users } from "./Manage";
import { Complaints, Disputes, ModerationQueue, OperatorOrders } from "./Queues";

const ADMIN_TABS = [
  ["dashboard", "Сводка"],
  ["moderation", "Модерация"],
  ["complaints", "Жалобы"],
  ["disputes", "Споры"],
  ["orders", "Заказы"],
  ["users", "Пользователи"],
  ["references", "Справочники"],
  ["settings", "Настройки"],
  ["audit", "Журнал"],
] as const;
type Tab = (typeof ADMIN_TABS)[number][0];

/** Staff panel inside the Mini App (auth = Telegram initData + role). Operators only see orders. */
export function Admin({ api, role, onOpenListing }: { api: Api; role: string; onOpenListing: (id: string) => void }) {
  const isAdmin = role === "admin";
  const tabs = isAdmin ? ADMIN_TABS : ADMIN_TABS.filter(([k]) => k === "orders");
  const [tab, setTab] = useState<Tab>(isAdmin ? "dashboard" : "orders");

  return (
    <div className="stack" data-testid="admin">
      <h1>{isAdmin ? "Админка" : "Заказы на доставку"}</h1>
      {tabs.length > 1 && (
        <div className="tabs scroll-x" role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" className={tab === k ? "active" : ""} onClick={() => setTab(k)} data-testid={`admin-tab-${k}`}>
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === "dashboard" && <Dashboard api={api} />}
      {tab === "moderation" && <ModerationQueue api={api} onOpen={onOpenListing} />}
      {tab === "complaints" && <Complaints api={api} onOpen={onOpenListing} />}
      {tab === "disputes" && <Disputes api={api} onOpen={onOpenListing} />}
      {tab === "orders" && <OperatorOrders api={api} />}
      {tab === "users" && <Users api={api} />}
      {tab === "references" && <References api={api} />}
      {tab === "settings" && <Settings api={api} />}
      {tab === "audit" && <AuditLog api={api} />}
    </div>
  );
}
