import { GUARANTEE_DAYS, INSPECTION_MINUTES } from "@ishonch/shared/client";
import { Icon } from "../components/Icon";
import { useT } from "../i18n";

const KEYS = ["money", "notfit", "refund", "address", "stolen", "video", "seller", "fee"] as const;
const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL ?? "";

/** «Вопросы и ответы»: what people ask before they trust a stranger with a deal, answered in plain words. */
export function Faq({ onHow }: { onHow: () => void }) {
  const t = useT();
  const params = { min: INSPECTION_MINUTES, days: GUARANTEE_DAYS };
  return (
    <div className="stack faq" data-testid="faq">
      <header className="how-head">
        <h1>{t("faq.title")}</h1>
        <p className="hint">{t("faq.intro")}</p>
      </header>
      <div className="stack-tight">
        {KEYS.map((k) => (
          <details key={k} className="faq-item" data-testid={`faq-${k}`}>
            <summary>
              <span>{t(`faq.${k}.q`)}</span>
              <Icon name="chevron" />
            </summary>
            <p>{t(`faq.${k}.a`, params)}</p>
          </details>
        ))}
      </div>
      <button className="secondary" onClick={onHow} data-testid="faq-how">
        <Icon name="timer" /> {t("how.open")}
      </button>
      {SUPPORT_URL && (
        <a className="primary link-button" href={SUPPORT_URL} target="_blank" rel="noreferrer" data-testid="faq-support">
          <Icon name="chat" /> {t("faq.support")}
        </a>
      )}
    </div>
  );
}
