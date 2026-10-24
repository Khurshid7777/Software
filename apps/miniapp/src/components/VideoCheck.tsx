import { useState } from "react";
import { MAX_VIDEO_BYTES, videoRequiredFor, videoSteps, type ListingDto } from "@ishonch/shared/client";
import { ApiError, apiUrl, type Api } from "../api";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { VideoVerdict } from "./VideoVerdict";

const MB = MAX_VIDEO_BYTES / 1024 / 1024;

/**
 * The video passport: one clip by a script (device on, IMEI / serial, battery, account, body). Required for
 * phones, tablets and laptops; the AI reads a few frames at upload and the seller sees at once what is missing.
 */
export function VideoCheck({ api, listing, onChange }: { api: Api; listing: ListingDto; onChange: (l: ListingDto) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const required = videoRequiredFor(listing.category);
  const steps = videoSteps(listing.category);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_VIDEO_BYTES) return setError(t("evidence.err.too_large", { mb: MB }));
    setBusy(true);
    try {
      const { video, videoCheck } = await api.uploadVideo(listing.id, file);
      onChange({ ...listing, video, videoCheck });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteVideo(listing.id);
      onChange({ ...listing, video: null, videoCheck: null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className={required && !listing.video ? "field stack video-passport required" : "field stack video-passport"} data-testid="video-check">
      <legend className="row">
        <Icon name="video" /> {t("sell.video.title")}
        <span className={required ? "tag tag-required" : "tag"} data-testid="video-required">
          {required ? t("sell.video.required") : t("sell.video.optional")}
        </span>
      </legend>
      <span className="hint">{t("sell.video.hint")}</span>
      <ol className="video-script" aria-label={t("sell.video.script")}>
        {steps.map((s) => (
          <li key={s}>
            <strong>{t(`video.step.${s}`)}</strong>
            <span className="hint">{t(`video.hint.${s}`)}</span>
          </li>
        ))}
      </ol>
      {listing.video && <video className="video-check" src={apiUrl(listing.video)} controls playsInline preload="metadata" data-testid="video-preview" />}
      {listing.video && listing.videoCheck && <VideoVerdict check={listing.videoCheck} steps={steps} forSeller />}
      <div className="row">
        <label className={busy ? "chip disabled" : "chip"}>
          {busy ? t("sell.video.checking") : listing.video ? t("sell.video.replace") : t("sell.video.add", { mb: MB })}
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            capture="environment"
            hidden
            disabled={busy}
            onChange={(e) => void upload(e.target.files?.[0])}
            data-testid="video-input"
          />
        </label>
        {listing.video && !busy && (
          <button className="link danger" onClick={remove} data-testid="video-remove">
            {t("sell.video.remove")}
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
