import { useEffect, useState } from "react";
import { BUNDLE_DISCOUNT_MAX_PCT, formatUzs, type CatalogItem } from "@ishonch/shared/client";
import { ApiError, apiUrl, compressImage, type Api, type ShopInfo } from "../api";
import { confirmDialog } from "../dialogs";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useLang, useT } from "../i18n";

export function Shop({ api, onOpen }: { api: Api; onOpen: (listingId: string) => void }) {
  const t = useT();
  const lang = useLang();
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [bundle, setBundle] = useState({ two: "", three: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);

  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [requests, setRequests] = useState<CatalogItem[]>([]);
  useEffect(() => {
    api.shopRequests().then(setRequests).catch(() => undefined);
  }, [api]);
  useEffect(() => {
    setFailed(false);
    api
      .shop()
      .then((s) => {
        setInfo(s);
        setName(s.shop?.name ?? "");
        setLocation(s.shop?.marketLocation ?? "");
        setBundle({ two: s.shop?.bundle2Pct ? String(s.shop.bundle2Pct) : "", three: s.shop?.bundle3Pct ? String(s.shop.bundle3Pct) : "" });
      })
      .catch(() => setFailed(true));
  }, [api, attempt]);

  const [busy, setBusy] = useState(false);
  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const pct = (v: string) => Math.min(BUNDLE_DISCOUNT_MAX_PCT, Number(v.replace(/\D/g, "")) || 0);
      const shop = await api.saveShop(name, location, info?.shop ? { bundle2Pct: pct(bundle.two), bundle3Pct: pct(bundle.three) } : undefined);
      setInfo((i) => (i ? { ...i, shop } : i));
      setMsg(info?.shop && (pct(bundle.two) !== info.shop.bundle2Pct || pct(bundle.three) !== info.shop.bundle3Pct) ? t("bundle.saved") : t("shop.saved"));
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  if (failed) return <LoadError onRetry={() => setAttempt((a) => a + 1)} />;
  if (!info) return <p className="hint center">{t("common.loading")}</p>;
  const shop = info.shop;
  return (
    <div className="stack">
      <h1>{t("shop.title")}</h1>
      <p className="hint">{t("shop.hint")}</p>
      {shop && <p className={shop.verified ? "badge" : "hint"}>{shop.verified ? t("shop.verified") : t("shop.not_verified")}</p>}

      <label className="field">
        {t("shop.name")}
        <input value={name} onChange={(e) => setName(e.target.value)} data-testid="shop-name" />
      </label>
      <label className="field">
        {t("shop.market_location")}
        <input value={location} onChange={(e) => setLocation(e.target.value)} />
      </label>
      {shop && (
        <label className="field">
          {t("shop.photo")}
          {shop.hasPhoto && <img className="shop-photo" src={`${apiUrl(`/shops/${shop.id}/photo`)}?v=${photoVersion}`} alt="" />}
          <input
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setBusy(true);
              try {
                const s = await api.shopPhoto(await compressImage(f));
                setInfo((i) => (i ? { ...i, shop: s } : i));
                setPhotoVersion((v) => v + 1);
                setMsg(t("common.saved"));
              } catch (err) {
                setMsg(err instanceof ApiError ? err.message : t("common.error"));
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
      )}
      {shop && (
        <div className="card stack-tight" data-testid="bundle-settings">
          <h4>🧺 {t("bundle.title")}</h4>
          <span className="hint">{t("bundle.hint")}</span>
          <div className="row">
            <label className="field">
              {t("bundle.two")}
              <input inputMode="numeric" maxLength={2} value={bundle.two} onChange={(e) => setBundle({ ...bundle, two: e.target.value })} data-testid="bundle-two" />
            </label>
            <label className="field">
              {t("bundle.three")}
              <input inputMode="numeric" maxLength={2} value={bundle.three} onChange={(e) => setBundle({ ...bundle, three: e.target.value })} data-testid="bundle-three" />
            </label>
          </div>
        </div>
      )}
      {msg && <Toast text={msg} onClose={() => setMsg(null)} />}
      <button className="primary" onClick={save} disabled={busy || name.trim().length < 2} data-testid="shop-save">
        {t("shop.save")}
      </button>

      {info.shop?.verified && (
        <div className="card stack" data-testid="shop-requests">
          <h4>🏪 {t("shop.requests")}</h4>
          {requests.length === 0 ? (
            <p className="hint">{t("shop.requests_empty")}</p>
          ) : (
            requests.map(({ listing: l }) => (
              <div key={l.id} className="row between" data-testid="shop-request">
                <span>
                  {lang === "ru" ? l.titleRu || l.titleUz : l.titleUz || l.titleRu}
                  {l.price ? <span className="hint"> · {formatUzs(l.price)}</span> : null}
                </span>
                <button className="chip" onClick={() => onOpen(l.id)}>
                  {t("shops_offer.make_offer")}
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="card stack">
        <h4>{t("shop.channels")}</h4>
        {info.channels.length === 0 && <p className="hint">{t("sell.no_channels")}</p>}
        {info.channels.map((c) => (
          <div key={c.id} className="row between">
            <span>📣 {c.title}</span>
            <button
              className="link danger"
              aria-label={t("shop.unlink")}
              onClick={async () => {
                if (!(await confirmDialog(t("shop.unlink_confirm", { title: c.title })))) return;
                try {
                  await api.unlinkChannel(c.id);
                  setInfo((i) => (i ? { ...i, channels: i.channels.filter((x) => x.id !== c.id) } : i));
                } catch (err) {
                  setMsg(err instanceof ApiError ? err.message : t("common.error"));
                }
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
