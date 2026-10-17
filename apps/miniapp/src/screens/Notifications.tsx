import { useEffect, useState } from "react";
import { NOTIFY_TYPES, type NotifyType } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useT } from "../i18n";

/** Optional bot messages, one switch per type (stage 20). Orders, meetings, disputes and chats always come. */
export function Notifications({ api }: { api: Api }) {
  const t = useT();
  const [off, setOff] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const load = () => {
    setFailed(false);
    api
      .me()
      .then((me) => setOff(me.notifyOff ?? []))
      .catch(() => setFailed(true));
  };
  useEffect(load, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(type: NotifyType, on: boolean) {
    const before = off;
    setOff((list) => (on ? (list ?? []).filter((x) => x !== type) : [...(list ?? []), type]));
    try {
      setOff((await api.setNotification(type, on)).notifyOff);
    } catch (e) {
      setOff(before);
      setToast(e instanceof ApiError ? e.message : t("common.error"));
    }
  }

  if (failed) return <LoadError onRetry={load} />;
  return (
    <div className="stack" data-testid="notifications">
      <h1>{t("notify.title")}</h1>
      <p className="hint">{t("notify.hint")}</p>
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
      {off === null ? (
        <p className="hint center">{t("common.loading")}</p>
      ) : (
        <section className="card stack">
          {NOTIFY_TYPES.map((type) => (
            <label key={type} className="check-row">
              <input type="checkbox" checked={!off.includes(type)} onChange={(e) => toggle(type, e.target.checked)} data-testid={`notify-${type}`} />
              {t(`notify.type.${type}`)}
            </label>
          ))}
        </section>
      )}
    </div>
  );
}
