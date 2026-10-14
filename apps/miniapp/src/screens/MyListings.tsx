import { useCallback, useEffect, useState } from "react";
import { EXPIRY_REMINDER_DAYS, formatUzs, listingPlainText, listingTitle, type ListingDto, type ListingStatus } from "@ishonch/shared";
import { ApiError, apiUrl, type Api } from "../api";
import { useLang, useT } from "../i18n";
import { useLatest } from "../useLatest";

// "active" also lists reserved items, "pending" also lists rejected ones (see GET /listings/mine).
const TABS: ListingStatus[] = ["active", "pending", "draft", "sold", "archived"];
const DAY = 864e5;

interface Props {
  api: Api;
  onEdit: (l: ListingDto) => void;
  onOpen: (id: string) => void;
}

export function MyListings({ api, onEdit, onOpen }: Props) {
  const t = useT();
  const lang = useLang();
  const [tab, setTab] = useState<ListingStatus>("active");
  const [items, setItems] = useState<ListingDto[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [soldFor, setSoldFor] = useState<string | null>(null);

  const begin = useLatest();
  const load = useCallback(() => {
    const isCurrent = begin();
    setItems(null);
    api
      .myListings(tab)
      .then((list) => isCurrent() && setItems(list))
      .catch(() => isCurrent() && (setItems([]), setToast(t("common.error"))));
  }, [api, tab, begin]);
  const [busy, setBusy] = useState(false);
  useEffect(load, [load]);

  const date = (iso: string) => new Date(iso).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ");

  async function act(fn: () => Promise<unknown>, ok?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (ok) setToast(ok);
      load();
    } catch (e) {
      if (e instanceof ApiError && e.code === "bump_too_soon") setToast(t("my.bump_at", { date: date(String(e.params.date)) }));
      else setToast(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1>{t("my.title")}</h1>
      <div className="tabs" role="tablist">
        {TABS.map((s) => (
          <button key={s} role="tab" className={tab === s ? "active" : ""} onClick={() => setTab(s)}>
            {t(`my.tab.${s as "active"}`)}
          </button>
        ))}
      </div>
      {toast && (
        <p className="toast" onClick={() => setToast(null)}>
          {toast}
        </p>
      )}
      {items === null && <p className="hint center">{t("common.loading")}</p>}
      {items?.length === 0 && <p className="hint center">{t("my.empty")}</p>}

      {items?.map((l) => (
        <article key={l.id} className="card listing-row" data-testid="my-listing">
          <button className="listing-main" onClick={() => (l.status === "draft" ? onEdit(l) : onOpen(l.id))}>
            {l.photos[0] ? <img src={apiUrl(l.photos[0].url)} alt="" /> : <div className="no-photo">📦</div>}
            <span>
              <strong>{listingTitle(l, lang) || "—"}</strong>
              {l.price && <span>{formatUzs(l.price)}</span>}
              {l.status !== "draft" && <span className="hint">{t("my.stats", l.stats)}</span>}
              {l.status === "active" && l.expiresAt && <span className="hint">{t("my.expires", { date: date(l.expiresAt) })}</span>}
              {l.soldVia && <span className="hint">{t(`my.sold_via.${l.soldVia}`)}</span>}
              {l.status === "reserved" && <span className="badge">{t("my.reserved")}</span>}
              {(l.status === "pending" || l.status === "rejected") && (
                <span className="badge">{t(`moderation.status.${l.status}`)}</span>
              )}
              {l.moderation?.reason && (
                <span className="hint" data-testid="moderation-reason">
                  {t("my.reason", { reason: t(`moderation.reason.${l.moderation.reason}` as "moderation.reason.other") })}
                  {l.moderation.message ? ` — ${l.moderation.message}` : ""}
                </span>
              )}
            </span>
          </button>

          {soldFor === l.id ? (
            <div className="row wrap">
              <span className="hint">{t("my.sold_question")}</span>
              <button className="chip" onClick={() => act(() => api.markSold(l.id, "platform")).then(() => setSoldFor(null))}>
                {t("my.sold_platform")}
              </button>
              <button className="chip" onClick={() => act(() => api.markSold(l.id, "elsewhere")).then(() => setSoldFor(null))}>
                {t("my.sold_elsewhere")}
              </button>
            </div>
          ) : (
            <div className="row wrap actions">
              {l.status === "active" && (
                <>
                  <button className="chip" onClick={() => act(() => api.bump(l.id), t("my.bumped"))}>⬆️ {t("my.bump")}</button>
                  <button className="chip" onClick={() => setSoldFor(l.id)}>✅ {t("my.sold")}</button>
                  <button className="chip" onClick={() => onEdit(l)}>✏️ {t("my.edit")}</button>
                  <button
                    className="chip"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(listingPlainText(l, lang))
                        .then(() => setToast(t("sell.copied")))
                        .catch(() => setToast(t("common.error")))
                    }
                  >
                    📋 OLX / Instagram
                  </button>
                  <button className="chip" onClick={() => act(() => api.archive(l.id))}>🗄 {t("my.archive")}</button>
                  {l.expiresAt && new Date(l.expiresAt).getTime() - Date.now() < EXPIRY_REMINDER_DAYS * DAY && (
                    <button className="chip" onClick={() => act(() => api.renew(l.id), t("my.renewed"))}>⏰ {t("my.renew")}</button>
                  )}
                </>
              )}
              {(l.status === "rejected" || l.status === "pending") && (
                <>
                  <button className="chip" onClick={() => onEdit(l)}>✏️ {t("my.edit")}</button>
                  {l.status === "rejected" && (
                    <button className="chip" onClick={() => act(() => api.publish(l.id, []))}>↩️ {t("sell.publish")}</button>
                  )}
                  <button className="chip" onClick={() => act(() => api.archive(l.id))}>🗄 {t("my.archive")}</button>
                </>
              )}
              {l.status === "draft" && <button className="chip" onClick={() => onEdit(l)}>✏️ {t("my.edit")}</button>}
              {l.status === "archived" && l.moderation?.reason === "expired" && (
                <button className="chip" onClick={() => act(() => api.renew(l.id), t("my.renewed"))}>↩️ {t("my.restore")}</button>
              )}
              {l.status === "archived" && l.moderation?.reason !== "expired" && l.moderation?.reason !== "banned" && (
                <button className="chip" onClick={() => act(() => api.publish(l.id, []))}>↩️ {t("my.restore")}</button>
              )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
