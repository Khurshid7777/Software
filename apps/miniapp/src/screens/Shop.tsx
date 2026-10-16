import { useEffect, useState } from "react";
import { ApiError, apiUrl, compressImage, type Api, type ShopInfo } from "../api";
import { confirmDialog } from "../dialogs";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useT } from "../i18n";

export function Shop({ api }: { api: Api }) {
  const t = useT();
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [photoVersion, setPhotoVersion] = useState(0);

  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setFailed(false);
    api
      .shop()
      .then((s) => {
        setInfo(s);
        setName(s.shop?.name ?? "");
        setLocation(s.shop?.marketLocation ?? "");
      })
      .catch(() => setFailed(true));
  }, [api, attempt]);

  const [busy, setBusy] = useState(false);
  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const shop = await api.saveShop(name, location);
      setInfo((i) => (i ? { ...i, shop } : i));
      setMsg(t("shop.saved"));
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
      {msg && <Toast text={msg} onClose={() => setMsg(null)} />}
      <button className="primary" onClick={save} disabled={busy || name.trim().length < 2}>
        {t("shop.save")}
      </button>

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
