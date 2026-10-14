import { useT } from "../i18n";
import { DocLink } from "../components/DocLink";

/** Legal texts are prepared by a lawyer; set their URLs via env when ready. */
const LINKS = {
  offer: import.meta.env.VITE_OFFER_URL ?? "",
  privacy: import.meta.env.VITE_PRIVACY_URL ?? "",
  prohibited: import.meta.env.VITE_PROHIBITED_URL ?? "",
};

export function Terms({ onAccept, busy }: { onAccept: () => void; busy: boolean }) {
  const t = useT();
  return (
    <div className="stack center">
      <h1>{t("terms.title")}</h1>
      <p>{t("terms.text")}</p>
      <ul className="links">
        {LINKS.offer && <li><DocLink url={LINKS.offer}>{t("terms.offer")}</DocLink></li>}
        {LINKS.privacy && <li><DocLink url={LINKS.privacy}>{t("terms.privacy")}</DocLink></li>}
        {LINKS.prohibited && <li><DocLink url={LINKS.prohibited}>{t("terms.prohibited")}</DocLink></li>}
      </ul>
      <button className="primary" onClick={onAccept} disabled={busy}>
        {t("terms.accept")}
      </button>
    </div>
  );
}
