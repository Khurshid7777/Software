import { useState } from "react";
import { readPref, writePref } from "../prefs";
import { useT } from "../i18n";

const STEPS = ["photos", "voice", "honest", "price"] as const;

/**
 * Stage 22: a first-time seller sees what makes a listing sell (Vinted / Mercari onboarding) and one good
 * example, once per device; publishing or «Понятно» hides it.
 */
export function FirstListingGuide() {
  const t = useT();
  const [shown, setShown] = useState(() => readPref("first_listing_guide") !== "1");
  const [example, setExample] = useState(false);
  if (!shown) return null;
  const close = () => {
    writePref("first_listing_guide", "1");
    setShown(false);
  };
  return (
    <section className="card stack" data-testid="first-listing-guide">
      <h3>{t("guide.title")}</h3>
      <ol className="stack-tight">
        {STEPS.map((s) => (
          <li key={s}>{t(`guide.step.${s}`)}</li>
        ))}
      </ol>
      <button className="link" onClick={() => setExample(!example)} aria-expanded={example} data-testid="guide-example-toggle">
        {example ? t("guide.example_hide") : t("guide.example_show")}
      </button>
      {example && (
        <div className="hint-card stack-tight" data-testid="guide-example">
          <strong>{t("guide.example_title")}</strong>
          <span>{t("guide.example_text")}</span>
          <span className="hint">{t("guide.example_why")}</span>
        </div>
      )}
      <button className="secondary" onClick={close} data-testid="guide-close">
        {t("guide.close")}
      </button>
    </section>
  );
}

/** Called after a successful publication: the guide is not needed any more. */
export const markFirstListingDone = () => writePref("first_listing_guide", "1");
