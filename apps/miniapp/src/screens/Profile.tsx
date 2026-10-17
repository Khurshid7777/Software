import type { Lang } from "@ishonch/shared/client";
import { useLang, useT } from "../i18n";
import { DocLink } from "../components/DocLink";

const LINKS = {
  offer: import.meta.env.VITE_OFFER_URL ?? "",
  privacy: import.meta.env.VITE_PRIVACY_URL ?? "",
};

type Target = "my" | "shop" | "favorites" | "check" | "admin" | "blocks";

interface Props {
  staff?: "admin" | "operator" | null;
  hasPhone: boolean;
  onOpen: (s: Target) => void;
  onLanguage: (lang: Lang) => void;
  onDeleteAccount: () => void;
}

/** Everything personal: the seller's cabinet, saved items, language, legal texts, account removal. */
export function Profile({ staff, hasPhone, onOpen, onLanguage, onDeleteAccount }: Props) {
  const t = useT();
  const lang = useLang();
  const row = (target: Target, icon: string, title: string, desc: string) => (
    <button className="menu-row" onClick={() => onOpen(target)} data-testid={`open-${target}`}>
      <span className="tile-icon" aria-hidden>
        {icon}
      </span>
      <span className="menu-text">
        <strong>{title}</strong>
        <span className="hint">{desc}</span>
      </span>
      <span className="chevron" aria-hidden>
        ›
      </span>
    </button>
  );
  return (
    <div className="stack" data-testid="profile">
      <div className="row between">
        <h1>{t("tab.profile")}</h1>
        <div className="lang-switch" role="group" aria-label={t("common.language")}>
          {(["uz", "ru"] as const).map((l) => (
            <button key={l} className={l === lang ? "active" : ""} onClick={() => onLanguage(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      {!hasPhone && <p className="hint-card">📱 {t("profile.phone_hint")}</p>}

      <section className="menu">
        {row("my", "📋", t("home.my.title"), t("home.my.desc"))}
        {row("shop", "🏪", t("home.shop.title"), t("home.shop.desc"))}
        {row("favorites", "❤️", t("home.favorites.title"), t("home.favorites.desc"))}
        {row("check", "🔎", t("home.tekshir.title"), t("home.tekshir.desc"))}
        {row("blocks", "🚫", t("blocks.open"), t("blocks.desc"))}
        {staff && row("admin", "🛠", staff === "admin" ? "Админка" : "Заказы на доставку", "Ishonch staff")}
      </section>

      {(LINKS.offer || LINKS.privacy) && (
        <section className="menu">
          {LINKS.offer && (
            <DocLink className="menu-row" url={LINKS.offer}>
              <span className="tile-icon" aria-hidden>
                📄
              </span>
              <span className="menu-text">
                <strong>{t("terms.offer")}</strong>
              </span>
            </DocLink>
          )}
          {LINKS.privacy && (
            <DocLink className="menu-row" url={LINKS.privacy}>
              <span className="tile-icon" aria-hidden>
                🔒
              </span>
              <span className="menu-text">
                <strong>{t("terms.privacy")}</strong>
              </span>
            </DocLink>
          )}
        </section>
      )}

      <button className="link danger" onClick={onDeleteAccount}>
        {t("home.delete_account")}
      </button>
    </div>
  );
}
