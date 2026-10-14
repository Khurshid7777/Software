import { useEffect, useRef, useState } from "react";
import { listingPlainText, type ListingDto, type ModerationDecision } from "@ishonch/shared/client";
import { ApiError, compressImage, type Api, type ShopInfo } from "../api";
import { ListingEditor } from "../components/ListingEditor";
import { useRecorder } from "../components/useRecorder";
import { useLang, useT } from "../i18n";
import { sharePhoneAndWait } from "../phone";

type Step = "capture" | "analyzing" | "questions" | "generating" | "edit" | "done";
const MAX_PHOTOS = 10;

interface Props {
  api: Api;
  /** Continue editing an existing draft/listing instead of starting from photos. */
  existing?: ListingDto;
  onDone: () => void;
}

export function Sell({ api, existing, onDone }: Props) {
  const t = useT();
  const lang = useLang();
  const [step, setStep] = useState<Step>(existing ? (existing.titleRu ? "edit" : "questions") : "capture");
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [listing, setListing] = useState<ListingDto | null>(existing ?? null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [needPhone, setNeedPhone] = useState(false);
  const [channels, setChannels] = useState<ShopInfo["channels"]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [posted, setPosted] = useState(0);
  const [moderation, setModeration] = useState<ModerationDecision>("approved");
  const [publishing, setPublishing] = useState(false);
  const [waitingPhone, setWaitingPhone] = useState(false);
  const pendingSave = useRef<Promise<unknown> | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const [copied, setCopied] = useState(false);
  const recorder = useRecorder();

  useEffect(() => {
    api
      .shop()
      .then((s) => {
        setChannels(s.channels);
        setSelected(s.channels.map((c) => c.id));
      })
      .catch(() => undefined);
  }, [api]);

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : t("common.error"));

  async function analyze() {
    setError(null);
    if (!files.length && !recorder.audio && !text.trim()) return setError(t("sell.need_photo_or_voice"));
    setStep("analyzing");
    try {
      const photos = await Promise.all(files.map((f) => compressImage(f, 2000)));
      const draft = await api.createDraft(photos, recorder.audio, text);
      setListing(draft);
      if (draft.questions.length) setStep("questions");
      else await generate(draft, {});
    } catch (e) {
      fail(e);
      setStep("capture");
    }
  }

  async function generate(l: ListingDto, a: Record<string, string>) {
    setStep("generating");
    try {
      setListing(await api.generate(l.id, a));
      setStep("edit");
    } catch (e) {
      fail(e);
      setStep("questions");
    }
  }

  async function publish() {
    if (!listing || publishing) return;
    setError(null);
    setPublishing(true);
    try {
      await pendingSave.current; // a field edited just before the tap is saved first
      const res = await api.publish(listing.id, selected);
      setListing(res.listing);
      setPosted(res.postedChannels);
      setModeration(res.moderation);
      setStep("done");
    } catch (e) {
      if (e instanceof ApiError && e.code === "phone_required") setNeedPhone(true);
      else fail(e);
    } finally {
      setPublishing(false);
    }
  }

  async function sharePhone() {
    if (waitingPhone) return;
    setWaitingPhone(true);
    const r = await sharePhoneAndWait(api, () => mounted.current);
    if (!mounted.current) return;
    setWaitingPhone(false);
    if (r === "ok") {
      setNeedPhone(false);
      return publish();
    }
    if (r === "timeout") setError(t("phone.timeout"));
  }

  if (step === "capture") {
    return (
      <div className="stack">
        <h1>{t("sell.title")}</h1>
        <p className="hint">{t("sell.photos_hint")}</p>
        <label className="file-picker">
          📷 {t("sell.add_photos")} ({files.length}/{MAX_PHOTOS})
          <input
            type="file"
            accept="image/*"
            multiple
            data-testid="sell-photos"
            onChange={(e) => {
              const next = [...files, ...Array.from(e.target.files ?? [])];
              if (next.length > MAX_PHOTOS) setError(t("sell.too_many_photos"));
              setFiles(next.slice(0, MAX_PHOTOS));
            }}
          />
        </label>
        {files.length > 0 && (
          <div className="thumbs">
            {files.map((f, i) => (
              <button key={`${f.name}-${f.size}-${i}`} className="thumb" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                <FilePreview file={f} />
              </button>
            ))}
          </div>
        )}
        {recorder.supported && (
          <button className={`secondary ${recorder.recording ? "recording" : ""}`} onClick={recorder.recording ? recorder.stop : recorder.start}>
            {recorder.recording ? t("sell.recording") : recorder.audio ? `✅ ${t("sell.voice_ready")}` : t("sell.record")}
          </button>
        )}
        <textarea rows={3} placeholder={t("sell.text_hint")} value={text} onChange={(e) => setText(e.target.value)} data-testid="sell-text" />
        {(error || recorder.error) && (
          <p className="error" role="alert">
            {error ?? t("sell.mic_unavailable")}
          </p>
        )}
        <button className="primary" onClick={analyze} data-testid="sell-analyze">
          {t("sell.analyze")}
        </button>
      </div>
    );
  }

  if (step === "analyzing" || step === "generating") {
    return (
      <div className="stack center">
        <div className="spinner" />
        <p>{t(step === "analyzing" ? "sell.analyzing" : "sell.generating")}</p>
      </div>
    );
  }

  if (step === "questions" && listing) {
    return (
      <div className="stack">
        <h2>{t("sell.questions_title")}</h2>
        {listing.questions.map((q) => (
          <div key={q.key} className="card stack">
            <strong>{lang === "ru" ? q.question_ru : q.question_uz}</strong>
            {q.options.length > 0 && (
              <div className="chips">
                {q.options.map((o) => (
                  <button key={o} className={`chip ${answers[q.key] === o ? "active" : ""}`} onClick={() => setAnswers({ ...answers, [q.key]: o })}>
                    {o}
                  </button>
                ))}
              </div>
            )}
            <input value={answers[q.key] ?? ""} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />
          </div>
        ))}
        {error && <p className="error">{error}</p>}
        <button className="primary" onClick={() => generate(listing, answers)} data-testid="sell-generate">
          {t("sell.generate")}
        </button>
      </div>
    );
  }

  if (step === "edit" && listing) {
    return (
      <div className="stack">
        <h2>{t("sell.edit_title")}</h2>
        <ListingEditor api={api} listing={listing} onChange={setListing} onSaving={(p) => (pendingSave.current = p)} />

        {listing.status !== "active" && (
          <div className="card stack">
            <h4>{t("sell.channels")}</h4>
            {channels.length === 0 && <p className="hint">{t("sell.no_channels")}</p>}
            {channels.map((c) => (
              <label key={c.id} className="check-row">
                <input
                  type="checkbox"
                  checked={selected.includes(c.id)}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))}
                />
                {c.title}
              </label>
            ))}
          </div>
        )}

        {needPhone && (
          <div className="card stack">
            <p>{t("sell.phone_required")}</p>
            <button className="secondary" onClick={sharePhone} disabled={waitingPhone}>
              📱 {t("sell.share_phone")}
            </button>
          </div>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {["active", "pending", "reserved"].includes(listing.status) ? (
          <button className="primary" onClick={onDone}>
            {t("shop.save")}
          </button>
        ) : (
          <button className="primary" onClick={publish} disabled={publishing} data-testid="sell-publish">
            {t("sell.publish")}
          </button>
        )}
      </div>
    );
  }

  if (step === "done" && listing) {
    return (
      <div className="stack center">
        {moderation === "approved" && <h2>🎉 {t("sell.published")}</h2>}
        {moderation === "needs_review" && <h2>⏸ {t("sell.published_pending")}</h2>}
        {moderation === "rejected" && (
          <>
            <h2>⛔️ {t("sell.published_rejected")}</h2>
            {listing.moderation?.message && <p>{listing.moderation.message}</p>}
          </>
        )}
        {posted > 0 && <p>{t("sell.posted_to_channels", { n: posted })}</p>}
        <button
          className="secondary"
          data-testid="copy-text"
          onClick={async () => {
            await navigator.clipboard.writeText(listingPlainText(listing, lang)).catch(() => undefined);
            setCopied(true);
          }}
        >
          📋 {copied ? t("sell.copied") : t("sell.copy_text")}
        </button>
        <button className="primary" onClick={onDone}>
          {t("my.title")}
        </button>
      </div>
    );
  }
  return null;
}

/** Preview of a picked file; the object URL is released when the thumbnail goes away. */
function FilePreview({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return src ? <img src={src} alt="" /> : null;
}
