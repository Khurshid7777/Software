import { useEffect, useState } from "react";
import type { Lang } from "@ishonch/shared/client";
import { useLang, useT } from "../i18n";
import { canAddToHomeScreen, promptAddToHomeScreen } from "../telegram";

interface Props {
  /** Staff see an entry to the admin panel (operators: delivery orders only). */
  staff?: "admin" | "operator" | null;
  remaining: number;
  onOpen: (screen: "check" | "sell" | "my" | "shop" | "catalog" | "assistant" | "favorites" | "orders" | "admin") => void;
  onLanguage: (lang: Lang) => void;
  onDeleteAccount: () => void;
}

export function Home({ staff, remaining, onOpen, onLanguage, onDeleteAccount }: Props) {
  const t = useT();
  const lang = useLang();
  const [homeScreen, setHomeScreen] = useState(false);
  useEffect(() => {
    canAddToHomeScreen().then(setHomeScreen);
  }, []);
  return (
    <div className="stack">
      <header className="row between">
        <div>
          <h1>{t("app.name")}</h1>
          <p className="hint">{t("app.tagline")}</p>
        </div>
        <div className="lang-switch" role="group" aria-label={t("common.language")}>
          {(["uz", "ru"] as const).map((l) => (
            <button key={l} className={l === lang ? "active" : ""} onClick={() => onLanguage(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      {staff && (
        <button className="tile" onClick={() => onOpen("admin")} data-testid="open-admin">
          <span className="tile-icon">🛠</span>
          <span>
            <strong>{staff === "admin" ? "Админка" : "Заказы на доставку"}</strong>
            <span className="hint">{staff === "admin" ? "Метрики, модерация, заказы, пользователи" : "Курьеры и статусы"}</span>
          </span>
        </button>
      )}

      <button className="tile primary-tile" onClick={() => onOpen("check")} data-testid="open-check">
        <span className="tile-icon">🔎</span>
        <span>
          <strong>{t("home.tekshir.title")}</strong>
          <span className="hint">{t("home.tekshir.desc")}</span>
          <span className="hint">{t("check.remaining", { n: remaining })}</span>
        </span>
      </button>

      <button className="tile" onClick={() => onOpen("catalog")} data-testid="open-catalog">
        <span className="tile-icon">🛍️</span>
        <span>
          <strong>{t("home.catalog.title")}</strong>
          <span className="hint">{t("home.catalog.desc_ready")}</span>
        </span>
      </button>

      <button className="tile" onClick={() => onOpen("assistant")} data-testid="open-assistant">
        <span className="tile-icon">🤖</span>
        <span>
          <strong>{t("home.assistant.title")}</strong>
          <span className="hint">{t("home.assistant.desc")}</span>
        </span>
      </button>

      <button className="tile" onClick={() => onOpen("favorites")}>
        <span className="tile-icon">❤️</span>
        <span>
          <strong>{t("home.favorites.title")}</strong>
          <span className="hint">{t("home.favorites.desc")}</span>
        </span>
      </button>

      <button className="tile" onClick={() => onOpen("orders")} data-testid="open-orders">
        <span className="tile-icon">🚚</span>
        <span>
          <strong>{t("home.orders.title")}</strong>
          <span className="hint">{t("home.orders.desc")}</span>
        </span>
      </button>

      <button className="tile" onClick={() => onOpen("sell")} data-testid="open-sell">
        <span className="tile-icon">📸</span>
        <span>
          <strong>{t("home.sell.title")}</strong>
          <span className="hint">{t("home.sell.desc_ready")}</span>
        </span>
      </button>

      <button className="tile" onClick={() => onOpen("my")} data-testid="open-my">
        <span className="tile-icon">📋</span>
        <span>
          <strong>{t("home.my.title")}</strong>
          <span className="hint">{t("home.my.desc")}</span>
        </span>
      </button>

      <button className="tile" onClick={() => onOpen("shop")}>
        <span className="tile-icon">🏪</span>
        <span>
          <strong>{t("home.shop.title")}</strong>
          <span className="hint">{t("home.shop.desc")}</span>
        </span>
      </button>

      {homeScreen && (
        <button
          className="link"
          onClick={() => {
            promptAddToHomeScreen();
            setHomeScreen(false);
          }}
        >
          📲 {t("home.add_to_home")}
        </button>
      )}

      <button className="link danger" onClick={onDeleteAccount}>
        {t("home.delete_account")}
      </button>
    </div>
  );
}
