import { useState } from "react";
import { MAX_VIDEO_BYTES, type ListingDto } from "@ishonch/shared/client";
import { ApiError, apiUrl, type Api } from "../api";
import { useT } from "../i18n";

const MB = MAX_VIDEO_BYTES / 1024 / 1024;

/** The seller's 15-second video check (switching on, screen, camera, body): goes into the item passport. */
export function VideoCheck({ api, listing, onChange }: { api: Api; listing: ListingDto; onChange: (l: ListingDto) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_VIDEO_BYTES) return setError(t("evidence.err.too_large", { mb: MB }));
    setBusy(true);
    try {
      const { video } = await api.uploadVideo(listing.id, file);
      onChange({ ...listing, video });
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
      onChange({ ...listing, video: null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="field stack" data-testid="video-check">
      <legend>{t("sell.video.title")}</legend>
      <span className="hint">{t("sell.video.hint")}</span>
      {listing.video && <video className="video-check" src={apiUrl(listing.video)} controls playsInline preload="metadata" data-testid="video-preview" />}
      <div className="row">
        <label className={busy ? "chip disabled" : "chip"}>
          {busy ? t("sell.video.uploading") : listing.video ? t("sell.video.replace") : `🎬 ${t("sell.video.add", { mb: MB })}`}
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
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
