import { useEffect, useState } from "react";
import type { CheckResult } from "@ishonch/shared/client";
import { ApiError, compressImage, type Api } from "../api";
import { CheckCard } from "../components/CheckCard";
import { useLang, useT } from "../i18n";

const MAX_IMAGES = 5;

interface Props {
  api: Api;
  remaining: number;
  onDone: (remaining: number) => void;
  onSimilar: (check: CheckResult) => void;
}

export function Check({ api, remaining, onDone, onSimilar }: Props) {
  const t = useT();
  const lang = useLang();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach(URL.revokeObjectURL);
  }, [files]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files, ...Array.from(list).filter((f) => f.type.startsWith("image/"))];
    if (next.length > MAX_IMAGES) setError(t("check.too_many_images"));
    setFiles(next.slice(0, MAX_IMAGES));
  }

  async function submit() {
    setError(null);
    if (!text.trim() && files.length === 0) return setError(t("check.empty_input"));
    setBusy(true);
    try {
      const images = await Promise.all(files.map((f) => compressImage(f)));
      const check = await api.createCheck(lang, text, images);
      setResult(check);
      onDone(check.remainingToday ?? remaining - 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="stack">
        <CheckCard check={result} />
        <button className="secondary" onClick={() => onSimilar(result)} data-testid="find-similar">
          🛍️ {t("bot.find_similar")}
        </button>
        <button
          className="primary"
          onClick={() => {
            setResult(null);
            setText("");
            setFiles([]);
          }}
        >
          {t("check.new")}
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1>{t("check.title")}</h1>
      <textarea
        data-testid="check-text"
        rows={6}
        placeholder={t("check.input_hint")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />

      <label className="file-picker">
        📎 {t("check.add_screenshots")}
        <input type="file" accept="image/*" multiple onChange={(e) => addFiles(e.target.files)} disabled={busy} />
      </label>
      {previews.length > 0 && (
        <div className="thumbs">
          {previews.map((src, i) => (
            <button key={src} className="thumb" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label="remove">
              <img src={src} alt="" />
            </button>
          ))}
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <p className="hint">{t("check.remaining", { n: remaining })}</p>

      <button className="primary" onClick={submit} disabled={busy || remaining <= 0} data-testid="check-submit">
        {busy ? t("common.loading") : t("check.submit")}
      </button>
      <p className="disclaimer">{t("ai.disclaimer")}</p>
    </div>
  );
}
