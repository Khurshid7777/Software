import type { Lang } from "@ishonch/shared/client";
import { useLang, useT } from "../i18n";
import { DocLink } from "../components/DocLink";
import { Icon, type IconName } from "../components/Icon";

const LINKS = {
  offer: import.meta.env.VITE_OFFER_URL ?? "",
  privacy: import.meta.env.VITE_PRIVACY_URL ?? "",
};

type Target = "my" | "shop" | "favorites" | "check" | "admin" | "blocks" | "notifications" | "stolen" | "away";

interface Props {
  staff?: "admin" | "operator" | null;
  hasPhone: boolean;
  onOpen: (s: Target) => void;
  onLanguage: (lang: Lang) => void;
  onDeleteAccount: () => void;
  /** «Скачать мои данные»: the bot sends a JSON file. */
  onExport: () => void;
}

/** Everything personal: the seller's cabinet, saved items, language, legal texts, account removal. */
export function Profile({ staff, hasPhone, onOpen, onLanguage, onDeleteAccount, onExport }: Props) {
  const t = useT();
  const lang = useLang();
  const row = (target: Target, icon: IconName, title: string, desc: string) => (
    <button className="menu-row" onClick={() => onOpen(target)} data-testid={`open-${target}`}>
      <span className="tile-icon" aria-hidden>
        <Icon name={icon} />
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
      {!hasPhone && <p className="hint-card"><Icon name="smartphone" /> {t("profile.phone_hint")}</p>}

      <section className="menu">
        {row("my", "list", t("home.my.title"), t("home.my.desc"))}
        {row("shop", "shop", t("home.shop.title"), t("home.shop.desc"))}
        {row("favorites", "heart", t("home.favorites.title"), t("home.favorites.desc"))}
        {row("check", "verify", t("home.tekshir.title"), t("home.tekshir.desc"))}
        {row("notifications", "bell", t("notify.open"), t("notify.desc"))}
        {row("away", "sun", t("away.open"), t("away.desc"))}
        {row("blocks", "ban", t("blocks.open"), t("blocks.desc"))}
        {row("stolen", "alert", t("stolen.open"), t("stolen.desc"))}
        {staff && row("admin", "wrench", staff === "admin" ? "Админка" : "Заказы на доставку", "Ishonch staff")}
      </section>

      {(LINKS.offer || LINKS.privacy) && (
        <section className="menu">
          {LINKS.offer && (
            <DocLink className="menu-row" url={LINKS.offer}>
              <span className="tile-icon" aria-hidden>
                <Icon name="doc" />
              </span>
              <span className="menu-text">
                <strong>{t("terms.offer")}</strong>
              </span>
            </DocLink>
          )}
          {LINKS.privacy && (
            <DocLink className="menu-row" url={LINKS.privacy}>
              <span className="tile-icon" aria-hidden>
                <Icon name="lock" />
              </span>
              <span className="menu-text">
                <strong>{t("terms.privacy")}</strong>
              </span>
            </DocLink>
          )}
        </section>
      )}

      <button className="link" onClick={onExport} data-testid="export-data">
        {t("export.button")}
      </button>
      <button className="link danger" onClick={onDeleteAccount}>
        {t("home.delete_account")}
      </button>
    </div>
  );
}
