import { useRef, useState } from "react";
import type { ListingPhoto } from "@ishonch/shared/client";
import { photoUrl, apiUrl } from "../api";
import { useT } from "../i18n";

/** Swipeable photos (scroll-snap, native momentum); a tap opens them full screen. */
export function Gallery({ photos }: { photos: ListingPhoto[] }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [full, setFull] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  if (!photos.length) return null;

  const onScroll = (el: HTMLDivElement) => setIndex(Math.round(el.scrollLeft / el.clientWidth));
  const goTo = (i: number) => track.current?.scrollTo({ left: i * track.current.clientWidth, behavior: "smooth" });

  return (
    <>
      <div className="gallery">
        <div className="gallery-track" ref={track} onScroll={(e) => onScroll(e.currentTarget)}>
          {photos.map((p, i) => (
            <button key={p.id} className="gallery-slide" onClick={() => setFull(i)} aria-label={t("listing.photo_open", { n: i + 1 })}>
              <img src={photoUrl(p.url, 960)} alt="" loading={i === 0 ? "eager" : "lazy"} />
            </button>
          ))}
        </div>
        {photos.length > 1 && (
          <>
            <span className="gallery-count">
              {index + 1}/{photos.length}
            </span>
            <div className="dots">
              {photos.map((p, i) => (
                <button key={p.id} className={i === index ? "active" : ""} onClick={() => goTo(i)} aria-label={t("listing.photo_open", { n: i + 1 })} />
              ))}
            </div>
          </>
        )}
      </div>
      {full !== null && (
        <div className="viewer" role="dialog" aria-modal="true" data-testid="photo-viewer">
          <button className="viewer-close" onClick={() => setFull(null)} aria-label={t("common.close")}>
            ✕
          </button>
          <div
            className="viewer-track"
            ref={(el) => {
              // Open on the tapped photo.
              if (el && el.dataset.opened !== "1") {
                el.dataset.opened = "1";
                el.scrollLeft = full * el.clientWidth;
              }
            }}
          >
            {photos.map((p) => (
              <div key={p.id} className="viewer-slide">
                <img src={apiUrl(p.url)} alt="" />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
