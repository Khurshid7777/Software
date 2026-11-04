import { useEffect, useMemo, useRef, useState } from "react";
import { FAQ_ACTIONS, FAQ_GROUPS, GUARANTEE_DAYS, INSPECTION_MINUTES, COMPARE_MAX, IMEI_CHECKS_PER_DAY, LISTING_TTL_DAYS, EXPIRY_REMINDER_DAYS, BUMP_INTERVAL_DAYS, MAX_VIDEO_BYTES, MEETING_FROM_HOUR, MEETING_TO_HOUR, OFFER_ACCEPTED_HOURS, OFFER_MIN_PCT, OFFER_PENDING_HOURS, VIDEO_CHECKS_PER_DAY, VIDEO_KEEP_DAYS_AFTER_SALE, type FaqAction, type FaqGroupId, type FaqId } from "@ishonch/shared/client";
import { Icon } from "../components/Icon";
import { useT } from "../i18n";

const SUPPORT_URL = import.meta.env.VITE_SUPPORT_URL ?? "";

/** Numbers that appear in the answers come from the same constants the app enforces, so the text cannot drift. */
const PARAMS = {
  min: INSPECTION_MINUTES,
  days: GUARANTEE_DAYS,
  compare: COMPARE_MAX,
  pct: OFFER_MIN_PCT,
  hours: OFFER_PENDING_HOURS,
  accepted: OFFER_ACCEPTED_HOURS,
  ttl: LISTING_TTL_DAYS,
  remind: EXPIRY_REMINDER_DAYS,
  bump: BUMP_INTERVAL_DAYS,
  mb: Math.round(MAX_VIDEO_BYTES / 1024 / 1024),
  imeiChecks: IMEI_CHECKS_PER_DAY,
  videoChecks: VIDEO_CHECKS_PER_DAY,
  keep: VIDEO_KEEP_DAYS_AFTER_SALE,
  from: MEETING_FROM_HOUR,
  to: MEETING_TO_HOUR,
};

interface Props {
  /** A question to open and scroll to (deep link or a «?» next to a screen). */
  open?: FaqId;
  onHow: () => void;
  onAction: (a: FaqAction) => void;
  /** Usage events: "yes" / "no" votes per question (nothing else is sent). */
  onVote?: (id: FaqId, helpful: boolean) => void;
}

/**
 * «Вопросы и ответы»: every question people ask before trusting a stranger with a deal, in eight topics, with
 * search, an answer-level button where an action helps, and a "did it help?" vote that tells us which answers to fix.
 */
export function Faq({ open, onHow, onAction, onVote }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<FaqGroupId | "all">("all");
  const [voted, setVoted] = useState<Record<string, boolean>>({});
  const target = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    target.current?.scrollIntoView({ block: "center" });
  }, [open]);

  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const groups = useMemo(
    () =>
      FAQ_GROUPS.filter((g) => group === "all" || g.id === group)
        .map((g) => ({
          id: g.id,
          items: (g.items as readonly FaqId[]).filter((id) => {
            if (!words.length) return true;
            const text = `${t(`faq.${id}.q`)} ${t(`faq.${id}.a`, PARAMS)}`.toLowerCase();
            return words.every((w) => text.includes(w));
          }),
        }))
        .filter((g) => g.items.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [group, query, t],
  );
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="stack faq" data-testid="faq">
      <header className="how-head">
        <h1>{t("faq.title")}</h1>
        <p className="hint">{t("faq.intro")}</p>
      </header>

      <label className="search-box inset">
        <Icon name="search" />
        <input type="search" placeholder={t("faq.search")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("faq.search")} data-testid="faq-search" />
      </label>
      <div className="chips scroll-x bleed" data-testid="faq-groups">
        <button className={group === "all" ? "chip active" : "chip"} aria-pressed={group === "all"} onClick={() => setGroup("all")}>
          {t("faq.all")}
        </button>
        {FAQ_GROUPS.map((g) => (
          <button key={g.id} className={group === g.id ? "chip active" : "chip"} aria-pressed={group === g.id} onClick={() => setGroup(g.id)} data-testid={`faq-group-${g.id}`}>
            {t(`faq.group.${g.id}`)}
          </button>
        ))}
      </div>
      {words.length > 0 && <p className="hint" data-testid="faq-count">{t("faq.count", { n: total })}</p>}

      {total === 0 && (
        <div className="empty" data-testid="faq-none">
          <span className="empty-icon" aria-hidden>
            🔍
          </span>
          <strong>{t("faq.none")}</strong>
          <p className="hint">{t("faq.none_text")}</p>
          <button className="secondary" onClick={() => (setQuery(""), setGroup("all"))}>
            {t("faq.clear")}
          </button>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.id} className="stack-tight">
          <h2 className="h-sub faq-group-title">{t(`faq.group.${g.id}`)}</h2>
          {g.items.map((id) => {
            const action = FAQ_ACTIONS[id];
            return (
              <details key={id} className="faq-item" data-testid={`faq-${id}`} open={id === open || undefined} ref={id === open ? target : undefined}>
                <summary>
                  <span>{t(`faq.${id}.q`)}</span>
                  <Icon name="chevron" />
                </summary>
                <p>{t(`faq.${id}.a`, PARAMS)}</p>
                {action && (
                  <button className="link" onClick={() => onAction(action)} data-testid={`faq-action-${id}`}>
                    {t(`faq.action.${action}`)} →
                  </button>
                )}
                <div className="faq-vote" data-testid={`faq-vote-${id}`}>
                  {voted[id] === undefined ? (
                    <>
                      <span className="hint">{t("faq.helpful")}</span>
                      <button className="chip" onClick={() => (setVoted({ ...voted, [id]: true }), onVote?.(id, true))} data-testid={`faq-yes-${id}`}>
                        {t("faq.yes")}
                      </button>
                      <button className="chip" onClick={() => (setVoted({ ...voted, [id]: false }), onVote?.(id, false))} data-testid={`faq-no-${id}`}>
                        {t("faq.no")}
                      </button>
                    </>
                  ) : (
                    <span className="hint">{voted[id] ? t("faq.thanks") : t("faq.thanks_no")}</span>
                  )}
                </div>
              </details>
            );
          })}
        </section>
      ))}

      <button className="secondary" onClick={onHow} data-testid="faq-how">
        <Icon name="timer" /> {t("how.open")}
      </button>
      {SUPPORT_URL && (
        <a className="primary link-button" href={SUPPORT_URL} target="_blank" rel="noreferrer" data-testid="faq-support">
          <Icon name="chat" /> {t("faq.support")}
        </a>
      )}
    </div>
  );
}
