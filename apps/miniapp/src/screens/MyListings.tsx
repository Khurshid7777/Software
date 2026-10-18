import { useCallback, useEffect, useRef, useState } from "react";
import { EXPIRY_REMINDER_DAYS, formatUzs, listingPlainText, listingTitle, type ListingDto, type ListingStatus } from "@ishonch/shared/client";
import { photoUrl, ApiError, type Api } from "../api";
import { confirmDialog } from "../dialogs";
import { Empty } from "../components/Empty";
import { Insights } from "../components/Insights";
import { SellFaster } from "../components/SellFaster";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useLang, useT } from "../i18n";
import { useLatest } from "../useLatest";
import { useOnShow } from "../leave";

// "active" also lists reserved items, "pending" also lists rejected ones (see GET /listings/mine).
const TABS: ListingStatus[] = ["active", "pending", "draft", "sold", "archived"];
const DAY = 864e5;

interface Props {
  api: Api;
  /** Top of the navigation stack: lists refresh when the user comes back (an edit, an order changed). */
  visible?: boolean;
  onEdit: (l: ListingDto) => void;
  onOpen: (id: string) => void;
  onSell: () => void;
}

export function MyListings({ api, visible = true, onEdit, onOpen, onSell }: Props) {
  const t = useT();
  const lang = useLang();
  const [tab, setTab] = useState<ListingStatus>("active");
  const [items, setItems] = useState<ListingDto[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [soldFor, setSoldFor] = useState<string | null>(null);
  const [insightsFor, setInsightsFor] = useState<string | null>(null);
  // Only the main actions are always visible; the rest sits behind «⋯ Ещё» (one card at a time).
  const [moreFor, setMoreFor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const begin = useLatest();
  const load = useCallback(() => {
    const isCurrent = begin();
    setItems(null);
    setFailed(false);
    api
      .myListings(tab)
      .then((list) => isCurrent() && setItems(list))
      .catch(() => isCurrent() && (setItems([]), setFailed(true)));
  }, [api, tab, begin]);
  const [busy, setBusy] = useState(false);
  useEffect(load, [load]);
  const shown = useRef(false);
  useOnShow(visible, () => (shown.current ? load() : (shown.current = true)));

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

  async function archive(id: string) {
    if (await confirmDialog(t("my.archive_confirm"))) await act(() => api.archive(id));
  }
  async function removeDraft(id: string) {
    if (await confirmDialog(t("my.delete_draft_confirm"))) await act(() => api.deleteDraft(id));
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
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
      {items === null && <p className="hint center">{t("common.loading")}</p>}
      {failed && <LoadError onRetry={load} />}
      {items?.length === 0 && !failed && (
        <Empty
          icon="📭"
          title={t("my.empty")}
          action={
            tab === "active" || tab === "draft" ? (
              <button className="primary" onClick={onSell}>
                📸 {t("home.sell.title")}
              </button>
            ) : undefined
          }
        />
      )}

      {items?.map((l) => (
        <article key={l.id} className={busy ? "card listing-row busy" : "card listing-row"} data-testid="my-listing">
          <button className="listing-main" onClick={() => (l.status === "draft" ? onEdit(l) : onOpen(l.id))}>
            {l.photos[0] ? <img src={photoUrl(l.photos[0].url, 240)} alt="" loading="lazy" /> : <div className="no-photo">📦</div>}
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
              <button className="chip" onClick={() => setSoldFor(null)}>
                {t("common.cancel")}
              </button>
            </div>
          ) : (
            <div className="row wrap actions">
              {l.status === "active" && (
                <>
                  <button className="chip" onClick={() => act(() => api.bump(l.id), t("my.bumped"))}>⬆️ {t("my.bump")}</button>
                  <button className="chip" onClick={() => setSoldFor(l.id)}>✅ {t("my.sold")}</button>
                  {l.expiresAt && new Date(l.expiresAt).getTime() - Date.now() < EXPIRY_REMINDER_DAYS * DAY && (
                    <button className="chip" onClick={() => act(() => api.renew(l.id), t("my.renewed"))}>⏰ {t("my.renew")}</button>
                  )}
                  <button
                    className={moreFor === l.id ? "chip active" : "chip"}
                    onClick={() => setMoreFor(moreFor === l.id ? null : l.id)}
                    aria-expanded={moreFor === l.id}
                    data-testid="my-more"
                  >
                    {moreFor === l.id ? t("my.less") : t("my.more")}
                  </button>
                  {moreFor === l.id && (
                    <>
                      <button className="chip" onClick={() => onEdit(l)}>✏️ {t("my.edit")}</button>
                      <button
                        className={insightsFor === l.id ? "chip active" : "chip"}
                        onClick={() => setInsightsFor(insightsFor === l.id ? null : l.id)}
                        data-testid="insights-open"
                      >
                        💡 {t("insights.button")}
                      </button>
                      <button
                        className="chip"
                        onClick={() =>
                          navigator.clipboard
                            .writeText(listingPlainText(l, lang))
                            .then(() => setToast(t("sell.copied")))
                            .catch(() => setToast(t("common.error")))
                        }
                      >
                        {t("my.copy_text")}
                      </button>
                      <button className="chip" onClick={() => archive(l.id)}>🗄 {t("my.archive")}</button>
                    </>
                  )}
                </>
              )}
              {(l.status === "rejected" || l.status === "pending") && (
                <>
                  <button className="chip" onClick={() => onEdit(l)}>✏️ {t("my.edit")}</button>
                  {l.status === "rejected" && (
                    <button className="chip" onClick={() => act(() => api.publish(l.id, []))}>↩️ {t("sell.publish")}</button>
                  )}
                  <button className="chip" onClick={() => archive(l.id)}>🗄 {t("my.archive")}</button>
                </>
              )}
              {l.status === "draft" && (
                <>
                  <button className="chip" onClick={() => onEdit(l)}>✏️ {t("my.edit")}</button>
                  <button className="chip" onClick={() => removeDraft(l.id)} data-testid="draft-delete">
                    🗑 {t("my.delete_draft")}
                  </button>
                </>
              )}
              {l.status === "archived" && l.moderation?.reason === "expired" && (
                <button className="chip" onClick={() => act(() => api.renew(l.id), t("my.renewed"))}>↩️ {t("my.restore")}</button>
              )}
              {l.status === "archived" && l.moderation?.reason !== "expired" && l.moderation?.reason !== "banned" && (
                <button className="chip" onClick={() => act(() => api.publish(l.id, []))}>↩️ {t("my.restore")}</button>
              )}
            </div>
          )}
          {l.status === "active" && soldFor !== l.id && (moreFor === l.id || l.autoDrop || l.likersOffer) && (
            <SellFaster api={api} listing={l} actions={moreFor === l.id} onDone={(m) => (setToast(m), load())} />
          )}
          {insightsFor === l.id && (
            <Insights
              api={api}
              listingId={l.id}
              onEdit={() => onEdit(l)}
              onBump={() => act(() => api.bump(l.id), t("my.bumped"))}
            />
          )}
        </article>
      ))}
    </div>
  );
}
