import type { VideoCheckResult, VideoStep } from "@ishonch/shared/client";
import { useLang, useT } from "../i18n";
import { Icon } from "./Icon";

/**
 * What the AI saw on the video passport: a chip per step of the script (✓ seen / ✗ missing) and its note.
 * `forSeller` adds the verdict line that tells the seller whether to re-shoot.
 */
export function VideoVerdict({ check, steps, forSeller = false }: { check: VideoCheckResult; steps: readonly VideoStep[]; forSeller?: boolean }) {
  const t = useT();
  const lang = useLang();
  const note = lang === "ru" ? check.noteRu : check.noteUz || check.noteRu;
  if (check.verdict === "unknown") {
    return forSeller ? (
      <p className="hint" data-testid="video-verdict">
        {t("sell.video.check.unknown")}
      </p>
    ) : null;
  }
  return (
    <div className={`video-verdict verdict-${check.verdict}`} data-testid="video-verdict">
      <p className="video-verdict-head">
        <Icon name={check.verdict === "pass" ? "ok" : check.verdict === "warn" ? "alert" : "cross"} />
        <strong>{forSeller ? t(`sell.video.check.${check.verdict}`) : t("listing.video_ai")}</strong>
      </p>
      <div className="video-steps">
        {steps.map((s) => {
          const seen = check.seen.includes(s);
          return (
            <span key={s} className={seen ? "video-step seen" : "video-step"} data-testid={`video-step-${s}`}>
              <Icon name={seen ? "check" : "close"} /> {t(`video.step.${s}`)}
            </span>
          );
        })}
      </div>
      {check.imeiMatch === true && (
        <p className="hint ok-text" data-testid="video-imei-ok">
          <Icon name="ok" /> {t("video.imei_ok")}
        </p>
      )}
      {note && <p className="hint">{note}</p>}
    </div>
  );
}
