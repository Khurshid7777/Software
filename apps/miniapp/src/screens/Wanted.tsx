import { useEffect, useState } from "react";
import { formatUzs, type WantedRequest } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { Empty } from "../components/Empty";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useT } from "../i18n";

/**
 * «Куплю» (stage 25): saved searches that buyers opened to sellers, without names. A seller whose live listing
 * fits sends it with one tap; the buyer gets it in the bot like a saved search alert.
 */
export function Wanted({ api, onSell }: { api: Api; onSell: () => void }) {
  const t = useT();
  const [items, setItems] = useState<WantedRequest[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => {
    setFailed(false);
    api
      .wanted()
      .then(setItems)
      .catch(() => (setItems([]), setFailed(true)));
  };
  useEffect(load, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function offer(r: WantedRequest, listingId: string) {
    if (busy) return;
    setBusy(`${r.id}:${listingId}`);
    try {
      await api.offerToWanted(r.id, listingId);
      setToast(t("wanted.sent"));
      setItems((list) =>
        list?.map((x) => (x.id === r.id ? { ...x, matches: x.matches.map((m) => (m.id === listingId ? { ...m, offered: true } : m)) } : x)) ?? null,
      );
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack" data-testid="wanted">
      <h1>🙋 {t("wanted.title")}</h1>
      <p className="hint">{t("wanted.hint")}</p>
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
      {items === null && <p className="hint center">{t("common.loading")}</p>}
      {failed && <LoadError onRetry={load} />}
      {items?.length === 0 && !failed && <Empty icon="🙋" title={t("wanted.empty")} />}
      {items?.map((r) => (
        <div key={r.id} className="card stack-tight" data-testid="wanted-row">
          <strong>{r.title}</strong>
          <span className="hint">
            {[
              r.priceMax ? t("wanted.up_to", { price: formatUzs(r.priceMax) }) : null,
              r.district ? t(`district.${r.district}` as "district.chilonzor") : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {r.matches.length === 0 ? (
            <button className="link" onClick={onSell}>
              {t("wanted.no_match")}
            </button>
          ) : (
            r.matches.map((m) => (
              <div key={m.id} className="row between">
                <span>
                  {m.title}
                  {m.price ? <span className="hint"> · {formatUzs(m.price)}</span> : null}
                </span>
                {m.offered ? (
                  <span className="hint" data-testid="wanted-offered">
                    ✓ {t("wanted.offered")}
                  </span>
                ) : (
                  <button className="chip" disabled={!!busy} onClick={() => offer(r, m.id)} data-testid="wanted-offer">
                    {t("wanted.offer")}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}
