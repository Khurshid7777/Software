import { useMemo, useState } from "react";
import {
  MEETING_SPOTS,
  checklistFields,
  formatUzs,
  meetingSlots,
  type MeetingDto,
  type MeetingSpot,
} from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { useLang, useT } from "../i18n";

const DAYS = 4;
const tashkent = (lang: string, opts: Intl.DateTimeFormatOptions) => (d: Date) =>
  d.toLocaleString(lang === "ru" ? "ru-RU" : "uz-UZ", { timeZone: "Asia/Tashkent", ...opts });

/** What to look at before paying, from the item's own checklist fields (docs/plan.md, stage 18). */
export function MeetChecklist({ category }: { category: string }) {
  const t = useT();
  const fields = checklistFields(category).filter((f) => ["accountUnlocked", "batteryPct", "biometrics", "repairs", "kit"].includes(f));
  const phone = fields.includes("accountUnlocked") || fields.includes("batteryPct");
  return (
    <div className="stack-tight" data-testid="meet-checklist">
      <strong>{t("meet.check_title")}</strong>
      <ul className="plain">
        <li>✅ {t("meet.check.generic")}</li>
        {fields.map((f) => (
          <li key={f}>✅ {t(`meet.check.${f as "kit"}`)}</li>
        ))}
        {phone && <li>✅ {t("meet.check.imei")}</li>}
      </ul>
    </div>
  );
}

export function SafetyNote() {
  const t = useT();
  return (
    <p className="hint-card" data-testid="meet-safety">
      <strong>{t("meet.safety_title")}</strong>
      <br />
      {t("meet.safety")}
    </p>
  );
}

/** «🤝 Встретиться лично»: a safe place from the list (or one's own), a day and an hour in daytime. */
export function MeetForm({ api, listingId, onSent, onError }: { api: Api; listingId: string; onSent: (m: MeetingDto) => void; onError: (msg: string) => void }) {
  const t = useT();
  const lang = useLang();
  const [spot, setSpot] = useState<MeetingSpot | "other">(MEETING_SPOTS[0]);
  const [place, setPlace] = useState("");
  const [day, setDay] = useState(0);
  const [at, setAt] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const now = useMemo(() => new Date(), []);
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => i).filter((i) => meetingSlots(now, i).length > 0), [now]);
  const day0 = days.includes(day) ? day : (days[0] ?? 0);
  const slots = meetingSlots(now, day0);
  const dayLabel = (i: number) =>
    i === 0 ? t("meet.today") : i === 1 ? t("meet.tomorrow") : tashkent(lang, { weekday: "short", day: "numeric" })(new Date(now.getTime() + i * 864e5));
  const hour = tashkent(lang, { hour: "2-digit", minute: "2-digit" });

  async function send() {
    if (!at || busy) return;
    setBusy(true);
    try {
      const m = await api.requestMeeting(listingId, {
        spot: spot === "other" ? null : spot,
        place: spot === "other" ? place.trim() : null,
        at,
        note: note.trim() || null,
      });
      onSent(m);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" data-testid="meet-form">
      <h3>{t("meet.title")}</h3>
      <span className="hint">{t("meet.hint")}</span>
      <strong>{t("meet.where")}</strong>
      <div className="chips">
        {[...MEETING_SPOTS, "other" as const].map((s) => (
          <button key={s} className={spot === s ? "chip active" : "chip"} onClick={() => setSpot(s)} data-testid={`meet-spot-${s}`}>
            {s === "other" ? t("meet.other_place") : t(`meet.spot.${s}`)}
          </button>
        ))}
      </div>
      {spot === "other" && (
        <>
          <input value={place} maxLength={200} placeholder={t("meet.place_placeholder")} onChange={(e) => setPlace(e.target.value)} data-testid="meet-place" />
          <p className="hint-card">{t("meet.custom_warning")}</p>
        </>
      )}
      <strong>{t("meet.day")}</strong>
      <div className="chips">
        {days.map((i) => (
          <button key={i} className={day0 === i ? "chip active" : "chip"} onClick={() => (setDay(i), setAt(null))} data-testid={`meet-day-${i}`}>
            {dayLabel(i)}
          </button>
        ))}
      </div>
      <strong>{t("meet.time")}</strong>
      {slots.length === 0 && <span className="hint">{t("meet.no_slots")}</span>}
      <div className="chips">
        {slots.map((s) => (
          <button
            key={s.toISOString()}
            className={at === s.toISOString() ? "chip active" : "chip"}
            onClick={() => setAt(s.toISOString())}
            data-testid="meet-slot"
          >
            {hour(s)}
          </button>
        ))}
      </div>
      <label className="field">
        {t("meet.note_label")}
        <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} data-testid="meet-note" />
      </label>
      <SafetyNote />
      <button className="primary" disabled={busy || !at || (spot === "other" && place.trim().length < 5)} onClick={send} data-testid="meet-send">
        {t("meet.send")}
      </button>
    </div>
  );
}

/** A meeting in «Заказы»: where, when, status; answer / cancel / «how did it go». */
export function MeetingCard({ meeting: m, onAction, onOpenListing }: { meeting: MeetingDto; onAction: (action: string, body?: object) => void; onOpenListing: () => void }) {
  const t = useT();
  const lang = useLang();
  const when = tashkent(lang, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })(new Date(m.at));
  const open = m.status === "pending" || m.status === "accepted";
  return (
    <article className="card stack-tight" id={`meeting-${m.id}`} data-testid="meeting-card">
      <button className="link" onClick={onOpenListing}>
        <strong>{m.title}</strong> {m.price ? `· ${formatUzs(m.price)}` : ""}
      </button>
      <span className="hint">{t(m.role === "buyer" ? "meet.with_seller" : "meet.with_buyer")}</span>
      <span>📍 {m.spot ? t(`meet.spot.${m.spot}`) : m.place}</span>
      <span>🕒 {when}</span>
      {m.note && <span className="hint">💬 {m.note}</span>}
      <span className="badge" data-testid="meeting-status">
        {t(`meet.status.${m.status}`)}
      </span>
      {open && m.role === "buyer" && <MeetChecklist category={m.category} />}
      {m.status === "accepted" && <SafetyNote />}
      <div className="row wrap">
        {m.actions.includes("accept") && (
          <button className="chip" onClick={() => onAction("accept")} data-testid="meeting-accept">
            {t("meet.accept")}
          </button>
        )}
        {m.actions.includes("decline") && (
          <button className="chip" onClick={() => onAction("decline")} data-testid="meeting-decline">
            {t("meet.decline")}
          </button>
        )}
        {m.actions.includes("report") && (
          <>
            <span className="hint">{t("meet.report_question")}</span>
            <button className="chip" onClick={() => onAction("report", { bought: true })} data-testid="meeting-bought">
              {t("meet.bought")}
            </button>
            <button className="chip" onClick={() => onAction("report", { bought: false })} data-testid="meeting-not-bought">
              {t("meet.not_bought")}
            </button>
          </>
        )}
        {m.actions.includes("confirm_sold") && (
          <button className="chip" onClick={() => onAction("confirm_sold")} data-testid="meeting-confirm-sold">
            {t("meet.confirm_sold")}
          </button>
        )}
        {m.actions.includes("cancel") && (
          <button className="link danger" onClick={() => onAction("cancel")} data-testid="meeting-cancel">
            {t("meet.cancel")}
          </button>
        )}
      </div>
    </article>
  );
}
