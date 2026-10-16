import { useState } from "react";
import {
  CONDITIONS,
  MVP_DELIVERY_MODES,
  FEE_PAYERS,
  IMEI_CATEGORIES,
  TASHKENT_DISTRICTS,
  formatUzs,
  isValidImei,
  type ListingDto,
} from "@ishonch/shared/client";
import { photoUrl, ApiError, compressImage, type Api, type ListingPatch } from "../api";
import { confirmDialog } from "../dialogs";
import { digitsOnly, groupDigits } from "../prefs";
import { useLang, useT } from "../i18n";
import { ChecklistEditor } from "./Checklist";

interface Props {
  api: Api;
  listing: ListingDto;
  onChange: (l: ListingDto) => void;
  /** Lets the parent wait for an in-flight save (e.g. Publish tapped right after editing a field). */
  onSaving?: (p: Promise<boolean>) => void;
}

/** Edit form shared by the sell wizard and "My listings → Edit". Saves on blur / change. */
export function ListingEditor({ api, listing, onChange, onSaving }: Props) {
  const t = useT();
  const lang = useLang();
  const [draft, setDraft] = useState<ListingPatch>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [imei, setImei] = useState<string | null>(null);
  const v = { ...listing, ...draft };

  function save(patch: ListingPatch) {
    setError(null);
    const p = (async () => {
      try {
        onChange(await api.updateListing(listing.id, patch));
        return true;
        // Drop only what was saved: text typed meanwhile in another field stays.
        setDraft((d) => {
          const rest = { ...d };
          for (const k of Object.keys(patch) as Array<keyof ListingPatch>) if (rest[k] === patch[k]) delete rest[k];
          return rest;
        });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : t("common.error"));
        return false;
      }
    })();
    onSaving?.(p);
    return p;
  }
  const field = <K extends keyof ListingPatch>(key: K) => ({
    value: (v[key] ?? "") as string,
    onChange: (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: e.target.value })),
    onBlur: () => draft[key] !== undefined && save({ [key]: draft[key] } as ListingPatch),
  });

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const blobs = await Promise.all(Array.from(files).map((f) => compressImage(f)));
      onChange(await api.addPhotos(listing.id, blobs));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const s = listing.priceSuggestion;
  return (
    <div className="stack" data-testid="listing-editor">
      <div className="thumbs">
        {listing.photos.map((p) => (
          <button
            key={p.id}
            className="thumb"
            aria-label={t("sell.photo_remove")}
            onClick={async () => {
              // Deleting is permanent (the file is removed on the server): ask first.
              if (!(await confirmDialog(t("sell.photo_remove_confirm")))) return;
              api
                .deletePhoto(listing.id, p.id)
                .then(onChange)
                .catch((e) => setError(e instanceof ApiError ? e.message : t("common.error")));
            }}
          >
            <img src={photoUrl(p.url, 240)} alt="" />
            <span className="thumb-x" aria-hidden>
              ✕
            </span>
          </button>
        ))}
        {listing.photos.length < 10 && (
          <label className="thumb add-thumb">
            {busy ? "…" : "+"}
            <input type="file" accept="image/*" multiple hidden onChange={(e) => addPhotos(e.target.files)} />
          </label>
        )}
      </div>

      {listing.photoHints.length > 0 && (
        <div className="card hint-card">
          <h4>💡 {t("sell.photo_hints")}</h4>
          <ul>
            {listing.photoHints.map((h) => (
              <li key={h.ru}>{lang === "ru" ? h.ru : h.uz}</li>
            ))}
          </ul>
        </div>
      )}

      <label className="field">
        {t("sell.field.title_uz")}
        <input data-testid="title-uz" maxLength={120} {...field("titleUz")} />
      </label>
      <label className="field">
        {t("sell.field.description_uz")}
        <textarea rows={5} {...field("descriptionUz")} />
      </label>
      <label className="field">
        {t("sell.field.title_ru")}
        <input data-testid="title-ru" maxLength={120} {...field("titleRu")} />
      </label>
      <label className="field">
        {t("sell.field.description_ru")}
        <textarea rows={5} {...field("descriptionRu")} />
      </label>

      <label className="field">
        {t("sell.field.price")}
        <input
          data-testid="price"
          inputMode="numeric"
          value={v.price ? groupDigits(String(v.price)) : ""}
          onChange={(e) => setDraft((d) => ({ ...d, price: Number(digitsOnly(e.target.value)) || null }))}
          onBlur={() => draft.price !== undefined && save({ price: draft.price })}
        />
      </label>
      {s && (
        <div className="chips" data-testid="price-suggestions">
          {(["quick", "market", "max"] as const).map((k) => (
            <button key={k} className={`chip ${v.price === s[k] ? "active" : ""}`} onClick={() => save({ price: s[k] })}>
              <span className="hint">{t(`sell.price.${k}`)}</span>
              <strong>{formatUzs(s[k])}</strong>
            </button>
          ))}
          {s.approximate && <p className="hint">{t("sell.price.approximate")}</p>}
        </div>
      )}

      <label className="field">
        {t("sell.field.condition")}
        <select value={v.condition ?? ""} onChange={(e) => save({ condition: (e.target.value || null) as ListingPatch["condition"] })}>
          <option value="">—</option>
          {CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {t(`condition.${c}`)}
            </option>
          ))}
        </select>
      </label>

      {(IMEI_CATEGORIES as readonly string[]).includes(listing.category) && (
        <label className="field">
          {t("sell.field.imei")}
          <input
            data-testid="imei"
            inputMode="numeric"
            maxLength={20}
            placeholder="*#06#"
            value={imei ?? listing.imei ?? ""}
            onChange={(e) => setImei(e.target.value)}
            onBlur={() => {
              if (imei === null) return;
              const clean = imei.replace(/[\s-]/g, "");
              if (clean && !isValidImei(clean)) return setError(t("sell.imei_invalid"));
              void save({ imei: clean || null }).then(() => setImei(null));
            }}
          />
          <span className="hint">{t("sell.imei_hint")}</span>
        </label>
      )}
      <ChecklistEditor category={listing.category} value={listing.checklist} onSave={(checklist) => void save({ checklist })} />

      <label className="check-row">
        <input
          type="checkbox"
          checked={listing.acceptsTrade}
          onChange={(e) => void save({ acceptsTrade: e.target.checked })}
          data-testid="accepts-trade"
        />
        <span>
          {t("trade.accepts_label")}
          <br />
          <span className="hint">{t("trade.accepts_hint")}</span>
        </span>
      </label>

      <label className="field">
        {t("sell.field.district")}
        <select value={v.district ?? ""} onChange={(e) => save({ district: (e.target.value || null) as ListingPatch["district"] })}>
          <option value="">—</option>
          {TASHKENT_DISTRICTS.map((d) => (
            <option key={d} value={d}>
              {t(`district.${d}`)}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="field">
        <legend>{t("sell.field.delivery")}</legend>
        {MVP_DELIVERY_MODES.map((m) => (
          <label key={m} className="check-row">
            <input
              type="checkbox"
              checked={v.allowedDeliveryModes?.includes(m) ?? false}
              onChange={(e) => {
                const cur = v.allowedDeliveryModes ?? [];
                const next = e.target.checked ? [...cur, m] : cur.filter((x) => x !== m);
                if (next.length) save({ allowedDeliveryModes: next });
              }}
            />
            {t(`delivery.${m}`)}
          </label>
        ))}
      </fieldset>

      <label className="field">
        {t("sell.field.fee_payer")}
        <select value={v.feePayer} onChange={(e) => save({ feePayer: e.target.value as ListingPatch["feePayer"] })}>
          {FEE_PAYERS.map((f) => (
            <option key={f} value={f}>
              {t(`fee_payer.${f}`)}
            </option>
          ))}
        </select>
      </label>

      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
