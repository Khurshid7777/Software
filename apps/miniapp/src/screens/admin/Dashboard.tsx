import { useEffect, useState } from "react";
import { formatUzs, type AdminMetrics, type FunnelStep } from "@ishonch/shared/client";
import { ApiError, type Api } from "../../api";
import { saveFile } from "../../dialogs";
import { STEP_LABEL, FEATURE_LABEL, CANCEL_LABEL, MODE_LABEL } from "./labels";

const PERIODS = [7, 30, 90] as const;

/** Key numbers, buyer/seller funnels, orders, AI spend and a day-by-day table. Staff UI is Russian-only. */
export function Dashboard({ api }: { api: Api }) {
  const [days, setDays] = useState<number>(30);
  const [m, setM] = useState<AdminMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setM(null);
    setError(null);
    api
      .adminMetrics(days)
      .then((r) => current && setM(r))
      .catch((e) => current && setError(e instanceof ApiError ? e.message : "Ошибка загрузки"));
    return () => {
      current = false;
    };
  }, [api, days]);

  async function downloadCsv() {
    // Telegram's own downloader on phones (a blob link does nothing in mobile webviews), the browser elsewhere.
    await saveFile(await api.ordersCsvLink(days), `ishonch-orders-${days}d.csv`);
  }

  if (error) return <p className="error">{error}</p>;
  // Newest first; days with no activity at all are hidden to keep the table short.
  const activeDays = m ? [...m.daily].reverse().filter((d) => d.newUsers || d.checks || d.published || d.orders || d.delivered || d.aiUsd) : [];
  return (
    <div className="stack" data-testid="admin-dashboard">
      <div className="tabs" role="tablist" aria-label="Период">
        {PERIODS.map((d) => (
          <button key={d} role="tab" className={days === d ? "active" : ""} onClick={() => setDays(d)}>
            {d} дн.
          </button>
        ))}
      </div>
      {!m ? (
        <p className="hint center">Загрузка…</p>
      ) : (
        <>
          <div className="kpis">
            <Kpi label="Пользователи" value={m.users.total} sub={`+${m.users.new} новых · ${m.users.active} активных`} />
            <Kpi label="Объявления" value={m.listings.active} sub={`+${m.listings.published} за период`} />
            <Kpi label="Доставлено" value={m.orders.delivered} sub={formatUzs(m.orders.gmvUzs)} />
            <Kpi
              label="Возвраты после осмотра"
              value={m.orders.returnRatePct == null ? "—" : `${m.orders.returnRatePct}%`}
              sub={`${m.orders.returned} из ${m.orders.delivered + m.orders.returned}`}
            />
            <Kpi
              label="AI за месяц"
              value={`$${m.ai.monthUsd.toFixed(2)}`}
              sub={`лимит $${m.ai.monthlyLimitUsd} · ${Math.round((m.ai.monthUsd / m.ai.monthlyLimitUsd) * 100)}%`}
              alert={m.ai.monthUsd >= m.ai.monthlyLimitUsd * 0.8}
            />
            <Kpi
              label="Ждут внимания"
              value={m.listings.pending + m.listings.complaints.open + m.orders.stuckOver24h}
              sub={`модерация ${m.listings.pending} · жалобы ${m.listings.complaints.open} · заказы >24ч ${m.orders.stuckOver24h}`}
              alert={m.orders.stuckOver24h > 0}
            />
          </div>

          {m.system.openDisputes > 0 && (
            <p className="card kpi-alert" data-testid="open-disputes">
              ⚖️ Открытых споров покупателей: {m.system.openDisputes} — вкладка «Споры».
            </p>
          )}
          {m.system.failedJobs > 0 && (
            <p className="card kpi-alert" data-testid="failed-jobs">
              🧯 Фоновых задач с ошибкой: {m.system.failedJobs} (посты в каналы, уведомления). В очереди: {m.system.queuedJobs}. Причины —
              в таблице jobs (last_error).
            </p>
          )}
          <Funnel title="Воронка покупателя" steps={m.buyerFunnel} />
          <Funnel title="Воронка продавца" steps={m.sellerFunnel} />

          <section className="card stack">
            <h3>Заказы</h3>
            <p className="hint">
              Создано {m.orders.created} · в работе {m.orders.open} · отменено {m.orders.cancelled}
              {m.orders.avgHoursToDeliver != null && ` · в среднем ${m.orders.avgHoursToDeliver} ч до доставки`}
            </p>
            <p className="hint">Сборы за доставку: {formatUzs(m.orders.deliveryFeesUzs)}</p>
            {m.orders.byMode.length > 0 && (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Способ</th>
                    <th className="num">Заказов</th>
                    <th className="num">Доставлено</th>
                  </tr>
                </thead>
                <tbody>
                  {m.orders.byMode.map((r) => (
                    <tr key={r.mode}>
                      <td>{MODE_LABEL[r.mode] ?? r.mode}</td>
                      <td className="num">{r.count}</td>
                      <td className="num">{r.delivered}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {m.orders.cancelReasons.length > 0 && (
              <>
                <strong>Причины отмен</strong>
                <ul className="plain">
                  {m.orders.cancelReasons.map((r) => (
                    <li key={r.reason} className="row between">
                      <span>{CANCEL_LABEL[r.reason] ?? r.reason}</span>
                      <span className="num">{r.count}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <button className="secondary" onClick={() => downloadCsv().catch(() => setNote("Не удалось скачать CSV"))}>
              ⬇️ Заказы за {days} дн. (CSV)
            </button>
          </section>

          <section className="card stack">
            <h3>Модерация и жалобы</h3>
            <p className="hint">
              Сразу опубликовано {m.listings.moderation.approved} · на проверку {m.listings.moderation.needsReview} · отклонено{" "}
              {m.listings.moderation.rejected}
            </p>
            <p className="hint">
              Жалоб за период {m.listings.complaints.period} · скрыто по жалобам {m.listings.complaints.hiddenListings}
            </p>
          </section>

          <section className="card stack">
            <h3>AI — ${m.ai.periodUsd.toFixed(2)} за период</h3>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Функция</th>
                  <th className="num">Вызовов</th>
                  <th className="num">$</th>
                </tr>
              </thead>
              <tbody>
                {m.ai.byFeature.map((r) => (
                  <tr key={r.feature}>
                    <td>{FEATURE_LABEL[r.feature] ?? r.feature}</td>
                    <td className="num">{r.calls}</td>
                    <td className="num">{r.usd.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card stack">
            <h3>По дням</h3>
            {activeDays.length < m.daily.length && (
              <p className="hint">Дни без активности скрыты ({m.daily.length - activeDays.length}).</p>
            )}
            <div className="table-wrap">
              <table className="admin-table" data-testid="daily-table">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th className="num">Нов.</th>
                    <th className="num">Пров.</th>
                    <th className="num">Объяв.</th>
                    <th className="num">Зак.</th>
                    <th className="num">Дост.</th>
                    <th className="num">AI $</th>
                  </tr>
                </thead>
                <tbody>
                  {activeDays.map((d) => (
                    <tr key={d.date}>
                      <td className="num">{`${d.date.slice(8)}.${d.date.slice(5, 7)}`}</td>
                      <td className="num">{d.newUsers}</td>
                      <td className="num">{d.checks}</td>
                      <td className="num">{d.published}</td>
                      <td className="num">{d.orders}</td>
                      <td className="num">{d.delivered}</td>
                      <td className="num">{d.aiUsd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <button
            className="link"
            onClick={() =>
              api
                .sendDigest()
                .then((r) => setNote(r.sent ? "Сводка отправлена в бот" : "Некому отправить: нет ADMIN_TELEGRAM_IDS"))
                .catch(() => setNote("Не удалось отправить сводку"))
            }
          >
            📨 Прислать утреннюю сводку сейчас
          </button>
          {note && <p className="toast" onClick={() => setNote(null)}>{note}</p>}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, alert }: { label: string; value: number | string; sub: string; alert?: boolean }) {
  return (
    <div className={`card kpi${alert ? " kpi-alert" : ""}`}>
      <span className="hint">{label}</span>
      <strong className="kpi-value">{value}</strong>
      <span className="hint">{sub}</span>
    </div>
  );
}

/**
 * One series of horizontal bars, length = users at the step relative to the first step.
 * Values and conversions are written next to each bar (text ink), so no legend is needed.
 */
function Funnel({ title, steps }: { title: string; steps: FunnelStep[] }) {
  const max = Math.max(1, ...steps.map((s) => s.users));
  return (
    <section className="card stack" data-testid="funnel">
      <h3>{title}</h3>
      <ol className="funnel">
        {steps.map((s) => (
          <li key={s.step} title={`${STEP_LABEL[s.step] ?? s.step}: ${s.users}`}>
            <div className="row between">
              <span>{STEP_LABEL[s.step] ?? s.step}</span>
              <span className="num">
                {s.users}
                {s.conversionPct != null && <span className="hint"> · {s.conversionPct}%</span>}
              </span>
            </div>
            <div className="funnel-track">
              <div className="funnel-bar" style={{ width: `${(s.users / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ol>
      <p className="hint">Уникальные пользователи, сделавшие шаг за период; % — от предыдущего шага.</p>
    </section>
  );
}
