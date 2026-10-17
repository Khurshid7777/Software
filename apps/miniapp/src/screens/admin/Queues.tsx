import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_INSPECTION_PHOTOS, formatUzs, inspectionChecks, type DisputeResolution, operatorNextStatuses, type InspectionCheck, type OrderStatus } from "@ishonch/shared/client";
import { ApiError, apiUrl, compressImage, type AdminDispute, type Api, type ChatReport, type ComplaintRow, type OperatorOrder, type QueueItem } from "../../api";
import { confirmDialog } from "../../dialogs";
import { Toast } from "../../components/Toast";
import { INSPECTION_LABEL, MODE_LABEL, NEXT_LABEL, REASON_LABEL, STATUS_LABEL, districtName } from "./labels";

function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const id = ++seq.current;
    setData(null);
    setError(null); // a failed action must not hide the list for good
    load()
      .then((d) => id === seq.current && setData(d))
      .catch((e) => id === seq.current && setError(e instanceof ApiError ? e.message : "Ошибка загрузки"));
  }, [load]);
  useEffect(reload, [reload]);
  return { data, error, reload, setError };
}

/** Pending listings: AI / duplicate / complaint reasons, approve or reject. */
export function ModerationQueue({ api, onOpen }: { api: Api; onOpen: (id: string) => void }) {
  const load = useCallback(() => api.moderationQueue(), [api]);
  const { data, error, reload, setError } = useLoad<QueueItem[]>(load);
  async function decide(id: string, d: "approve" | "reject") {
    await api.moderate(id, d).catch((e) => setError(e instanceof ApiError ? e.message : "Ошибка"));
    reload();
  }
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="hint center">Загрузка…</p>;
  if (!data.length) return <p className="hint center">Очередь пуста 🎉</p>;
  return (
    <div className="stack">
      {data.map(({ listing: l, moderation, openComplaints }) => (
        <article key={l.id} className="card stack" data-testid="queue-item">
          <button className="listing-main" onClick={() => onOpen(l.id)}>
            {l.photos[0] ? <img src={apiUrl(l.photos[0].url)} alt="" /> : <div className="no-photo">📦</div>}
            <span>
              <strong>{l.titleRu || l.titleUz || "—"}</strong>
              {l.price && <span>{formatUzs(l.price)}</span>}
              <span className="hint">
                {l.seller?.shop ? `🏪 ${l.seller.shop.name}` : "Частный продавец"} · продаж {l.seller?.platformSales ?? 0}
              </span>
            </span>
          </button>
          <ul className="plain">
            {(moderation?.reasons ?? []).map((r, i) => (
              <li key={i}>
                <strong>{REASON_LABEL[r.code] ?? r.code}</strong> <span className="hint">— {r.note}</span>
              </li>
            ))}
            {openComplaints > 0 && <li className="hint">Открытых жалоб: {openComplaints}</li>}
            {moderation?.duplicates?.map((id) => (
              <li key={id}>
                <button className="link" onClick={() => onOpen(id)}>
                  Похожее объявление →
                </button>
              </li>
            ))}
          </ul>
          <div className="row wrap">
            <button className="chip" onClick={() => decide(l.id, "approve")} data-testid="approve">
              ✅ Одобрить
            </button>
            <button className="chip" onClick={() => decide(l.id, "reject")}>
              ⛔️ Отклонить
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

export function Complaints({ api, onOpen }: { api: Api; onOpen: (id: string) => void }) {
  const load = useCallback(() => api.complaints(), [api]);
  const { data, error } = useLoad<ComplaintRow[]>(load);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="hint center">Загрузка…</p>;
  if (!data.length) return <p className="hint center">Открытых жалоб нет</p>;
  // Group by listing: moderators decide per listing, not per complaint.
  const groups = [...data.reduce((m, c) => m.set(c.listingId, [...(m.get(c.listingId) ?? []), c]), new Map<string, ComplaintRow[]>())];
  return (
    <div className="stack">
      <p className="hint">Объявление скрывается автоматически после жалоб от нескольких пользователей и появляется в «Модерации».</p>
      {groups.map(([listingId, list]) => (
        <article key={listingId} className="card stack">
          <div className="row between">
            <button className="link" onClick={() => onOpen(listingId)}>
              <strong>{list[0]!.listingTitle || "—"}</strong>
            </button>
            <span className="badge">{list.length}</span>
          </div>
          <span className="hint">Статус: {list[0]!.listingStatus}</span>
          <ul className="plain">
            {list.map((c) => (
              <li key={c.id}>
                {REASON_LABEL[c.reason] ?? c.reason}
                {c.text && <span className="hint"> — «{c.text}»</span>}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

const DISPUTE_REASON: Record<string, string> = {
  not_as_described: "Не соответствует описанию",
  hidden_defect: "Скрытый дефект",
  not_working: "Не работает",
  counterfeit: "Подделка",
  incomplete: "Неполная комплектация",
  other: "Другое",
};
const RESOLUTION_LABEL: Record<string, string> = { refund: "Возврат товара и денег", partial: "Частичная компенсация", rejected: "Отказ" };

/** Ishonch guarantee: both stories, the courier's inspection and phones; refund / compensation / reject. */
export function Disputes({ api, onOpen }: { api: Api; onOpen: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const load = useCallback(() => api.adminDisputes(all), [api, all]);
  const { data, error, reload, setError } = useLoad<AdminDispute[]>(load);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  async function resolve(d: AdminDispute, resolution: DisputeResolution) {
    const amount = resolution === "partial" ? Number(amounts[d.id] ?? 0) : undefined;
    const label = resolution === "partial" ? `компенсацию ${formatUzs(amount ?? 0)}` : RESOLUTION_LABEL[resolution]!.toLowerCase();
    if (!(await confirmDialog(`Решение по спору «${d.title}»: ${label}?`))) return;
    await api.resolveDispute(d.id, resolution, amount, notes[d.id]).catch((e) => setError(e instanceof ApiError ? e.message : "Ошибка"));
    reload();
  }
  return (
    <div className="stack">
      <p className="hint">
        Защита покупателя: спор в течение 3 дней после доставки. Ishonch деньги не хранит — решение выполняет продавец (возврат или часть суммы); решение против продавца засчитывается ему
        (снижают его уровень доверия).
      </p>
      <label className="check-row">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        показать решённые
      </label>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="hint center">Загрузка…</p>}
      {data && !data.length && <p className="hint center">Открытых споров нет 🎉</p>}
      {data?.map((d) => (
        <article key={d.id} className="card stack" data-testid="dispute-item">
          <div className="row between">
            <button className="link" onClick={() => onOpen(d.listingId)}>
              <strong>{d.title || "—"}</strong>
            </button>
            <span className="badge">{formatUzs(d.itemPrice)}</span>
          </div>
          <span>⚖️ {DISPUTE_REASON[d.reason] ?? d.reason}</span>
          <span className="hint">Покупатель: «{d.text}»</span>
          <span className="hint">{d.sellerResponse ? `Продавец: «${d.sellerResponse}»` : "Продавец ещё не ответил"}</span>
          {d.photos.length > 0 && (
            <div className="evidence-row" data-testid="dispute-photos">
              {d.photos.map((u) => (
                <a key={u} href={apiUrl(u)} target="_blank" rel="noreferrer">
                  <img src={apiUrl(u)} alt="Фото покупателя" />
                </a>
              ))}
            </div>
          )}
          {d.inspectionPhotos.length > 0 && (
            <>
              <span className="hint">Фото курьера при получении:</span>
              <div className="evidence-row">
                {d.inspectionPhotos.map((u) => (
                  <a key={u} href={apiUrl(u)} target="_blank" rel="noreferrer">
                    <img src={apiUrl(u)} alt="Фото курьера" />
                  </a>
                ))}
              </div>
            </>
          )}
          {d.inspection && (
            <span className="hint">
              🔍 Осмотр курьером: {d.inspection.passed ? "пройден" : "были замечания"}
              {d.inspection.note && ` — ${d.inspection.note}`}
            </span>
          )}
          <span className="hint">
            📞 покупатель {d.buyerPhone ?? "—"} · продавец {d.sellerPhone ?? "—"}
          </span>
          {d.status === "open" ? (
            <>
              <input placeholder="Комментарий к решению (увидят обе стороны)" maxLength={500} value={notes[d.id] ?? ""} onChange={(e) => setNotes({ ...notes, [d.id]: e.target.value })} />
              <div className="row">
                <input
                  inputMode="numeric"
                  placeholder="Сумма компенсации"
                  value={amounts[d.id] ?? ""}
                  onChange={(e) => setAmounts({ ...amounts, [d.id]: e.target.value.replace(/\D/g, "") })}
                  data-testid="dispute-amount"
                />
                <button className="chip" disabled={!Number(amounts[d.id])} onClick={() => resolve(d, "partial")} data-testid="dispute-partial">
                  Компенсация
                </button>
              </div>
              <div className="row">
                <button className="chip" onClick={() => resolve(d, "refund")} data-testid="dispute-refund">
                  ↩️ Возврат
                </button>
                <button className="chip danger" onClick={() => resolve(d, "rejected")} data-testid="dispute-reject">
                  Отказать
                </button>
              </div>
            </>
          ) : (
            <span className="hint-card">
              {RESOLUTION_LABEL[d.resolution ?? ""] ?? d.resolution}
              {d.amount ? ` — ${formatUzs(d.amount)}` : ""}
              {d.note && ` · ${d.note}`}
            </span>
          )}
        </article>
      ))}
    </div>
  );
}

/**
 * Courier's checklist at pickup: each line is "ok" / "problem" / not checked. Any problem = not passed
 * (the listing loses the badge, the seller's record shows it).
 */
function InspectionForm({ category, hasImei, onSubmit }: { category: string; hasImei: boolean; onSubmit: (c: Partial<Record<InspectionCheck, boolean>>, note?: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState<Partial<Record<InspectionCheck, boolean>>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button className="chip" onClick={() => setOpen(true)} data-testid="op-inspect">
        🔍 Осмотр при получении
      </button>
    );
  const items = inspectionChecks(category, hasImei);
  return (
    <div className="card stack" data-testid="op-inspection-form">
      {items.map((c) => (
        <div key={c} className="row between insp-row">
          <span>{INSPECTION_LABEL[c]}</span>
          <span className="chips">
            {([true, false] as const).map((v) => (
              <button
                key={String(v)}
                className={checks[c] === v ? "chip active" : "chip"}
                onClick={() => setChecks((s) => {
                  const next = { ...s };
                  if (next[c] === v) delete next[c];
                  else next[c] = v;
                  return next;
                })}
                data-testid={`insp-${c}-${v ? "ok" : "bad"}`}
              >
                {v ? "✓ ок" : "✗ нет"}
              </button>
            ))}
          </span>
        </div>
      ))}
      <input placeholder="Замечание (необязательно)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      <button
        className="secondary"
        disabled={busy || Object.keys(checks).length === 0}
        onClick={async () => {
          setBusy(true);
          await onSubmit(checks, note.trim() || undefined).finally(() => setBusy(false));
        }}
        data-testid="insp-save"
      >
        Сохранить осмотр
      </button>
    </div>
  );
}

const ORDER_FILTERS: Array<OrderStatus | "open"> = ["open", "new", "confirmed", "courier_assigned", "picked_up", "delivered", "returned"];

/** Operators: open orders with contacts and the next status buttons (same rules as the bot buttons). */
export function OperatorOrders({ api }: { api: Api }) {
  const [filter, setFilter] = useState<OrderStatus | "open">("open");
  const load = useCallback(() => api.operatorOrders(filter === "open" ? undefined : filter), [api, filter]);
  const { data, error, reload, setError } = useLoad<OperatorOrder[]>(load);
  const [courier, setCourier] = useState<Record<string, string>>({});

  async function move(o: OperatorOrder, s: OrderStatus) {
    if (s === "cancelled" && !(await confirmDialog("Отменить заказ?"))) return;
    try {
      await api.operatorStatus(o.id, s, s === "courier_assigned" && courier[o.id] ? { courierName: courier[o.id] } : {});
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Ошибка");
    }
  }

  return (
    <div className="stack">
      <div className="chips scroll-x">
        {ORDER_FILTERS.map((f) => (
          <button key={f} className={filter === f ? "chip active" : "chip"} onClick={() => setFilter(f)}>
            {f === "open" ? "В работе" : STATUS_LABEL[f]}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="hint center">Загрузка…</p>}
      {data?.length === 0 && <p className="hint center">Заказов нет</p>}
      {data?.map((o) => {
        const q = o.quote;
        const next = operatorNextStatuses(o.status);
        const stale = Date.now() - new Date(o.updatedAt).getTime() > 24 * 3600_000 && next.length > 0;
        return (
          <article key={o.id} className={`card stack${stale ? " kpi-alert" : ""}`} data-testid="op-order">
            <div className="row between">
              <strong>#{o.id.slice(0, 8)} · {STATUS_LABEL[o.status]}</strong>
              {stale && <span className="badge">⏳ &gt;24 ч</span>}
            </div>
            <span>{o.listing.titleRu || o.listing.titleUz}</span>
            {o.bundle.length > 0 && (
              <span className="hint">🧺 Сборный заказ, одна поездка: + {o.bundle.map((b) => b.titleRu || b.titleUz).join(", ")}</span>
            )}
            <span className="hint">
              {MODE_LABEL[o.mode]} · {o.mode === "delivery_only" ? "наличные не собирать" : `собрать ${formatUzs(q.buyerTotal)}`}
            </span>
            {q.vehicle === "cargo" && (
              <span data-testid="op-cargo">
                🚚 Грузовое такси с грузчиками{q.lift ? ` — ${q.lift.floor} этаж, ${q.lift.elevator ? "есть лифт" : "без лифта"}` : ""}
              </span>
            )}
            <span className="hint">
              Доставка {formatUzs(q.deliveryFee)}
              {q.liftFee ? ` + ${formatUzs(q.liftFee)} подъём` : ""}
              {q.codFee ? ` + ${formatUzs(q.codFee)} за наличные` : ""}
            </span>
            <span>📍 {districtName(o.district)}, {o.address}</span>
            {o.comment && <span className="hint">💬 {o.comment}</span>}
            <span className="hint">
              Покупатель {o.contacts.buyerPhone ?? "—"} · продавец {o.contacts.sellerPhone ?? "—"}
            </span>
            {o.imei && <span className="hint">🔐 IMEI {o.imei} — сверить с *#06# при получении</span>}
            {o.inspection ? (
              <span className="hint" data-testid="op-inspection-result">
                🔍 Осмотр {o.inspection.passed ? "✅ пройден" : "⚠️ замечания"}:{" "}
                {Object.entries(o.inspection.checks)
                  .map(([k, v]) => `${INSPECTION_LABEL[k as InspectionCheck]} ${v ? "✓" : "✗"}`)
                  .join(", ")}
                {o.inspection.note && ` — ${o.inspection.note}`}
              </span>
            ) : (
              ["confirmed", "courier_assigned", "picked_up"].includes(o.status) && (
                <InspectionForm category={o.category} hasImei={!!o.imei} onSubmit={(checks, note) => api.inspect(o.id, checks, note).then(reload, (e) => setError(e instanceof ApiError ? e.message : "Ошибка"))} />
              )
            )}
            {["confirmed", "courier_assigned", "picked_up", "delivered"].includes(o.status) && (
              <label className="chip" data-testid="op-inspection-photos">
                📷 Фото осмотра (до {MAX_INSPECTION_PHOTOS}) — попадут в паспорт товара
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={async (e) => {
                    const files = Array.from(e.target.files ?? []);
                    if (!files.length) return;
                    try {
                      const blobs = await Promise.all(files.map((f) => compressImage(f)));
                      const { photos } = await api.inspectionPhotos(o.id, blobs);
                      setError(`Фото осмотра сохранены: ${photos.length}`);
                    } catch (err) {
                      setError(err instanceof ApiError ? err.message : "Ошибка");
                    }
                  }}
                />
              </label>
            )}
            {o.courier?.name && <span className="hint">Курьер: {o.courier.name}</span>}
            {next.includes("courier_assigned") && (
              <input
                placeholder="Имя курьера (необязательно)"
                value={courier[o.id] ?? ""}
                onChange={(e) => setCourier({ ...courier, [o.id]: e.target.value })}
              />
            )}
            {next.length > 0 && (
              <div className="row wrap">
                {next.map((s) => (
                  <button key={s} className="chip" onClick={() => move(o, s)} data-testid={`op-${s}`}>
                    {NEXT_LABEL[s] ?? s}
                  </button>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

const CHAT_REASON: Record<string, string> = {
  prepayment: "просит предоплату",
  scam: "мошенничество",
  rude: "оскорбления",
  spam: "спам",
  other: "другое",
};

/** Stage 19: reports about masked conversations, with the last messages; warn, ban or dismiss. */
export function ChatReports({ api, onOpen }: { api: Api; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<ChatReport[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .chatReports()
      .then(setItems)
      .catch(() => setItems([]));
  }, [api]);
  useEffect(load, [load]);
  async function resolve(r: ChatReport, resolution: "dismissed" | "warned" | "banned") {
    try {
      if (resolution === "banned") await api.ban(r.reported.id, `Жалоба на переписку: ${CHAT_REASON[r.reason] ?? r.reason}`);
      await api.resolveChatReport(r.id, resolution);
      load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Ошибка");
    }
  }
  if (!items) return <p className="hint center">Загрузка…</p>;
  return (
    <div className="stack" data-testid="chat-reports">
      <p className="hint">Жалобы на переписку. Имена скрыты; видно, кто писал — покупатель или продавец.</p>
      {msg && <Toast text={msg} onClose={() => setMsg(null)} />}
      {items.length === 0 && <p className="hint center">Жалоб нет</p>}
      {items.map((r) => (
        <article key={r.id} className="card stack-tight" data-testid="chat-report">
          <button className="link" onClick={() => onOpen(r.listing.id)}>
            <strong>{r.listing.title}</strong>
          </button>
          <span>
            На {r.reported.role === "seller" ? "продавца" : "покупателя"}: {CHAT_REASON[r.reason] ?? r.reason} · всего жалоб на него: {r.reported.reports}
            {r.reported.banned ? " · уже заблокирован" : ""}
          </span>
          <div className="stack-tight">
            {r.messages.map((m, i) => (
              <span key={i} className="hint">
                <b>{m.from === "seller" ? "Продавец" : "Покупатель"}:</b> {m.text}
              </span>
            ))}
          </div>
          <div className="row wrap">
            <button className="chip" onClick={() => resolve(r, "warned")}>Предупредить</button>
            {!r.reported.banned && (
              <button className="chip" onClick={() => resolve(r, "banned")} data-testid="chat-report-ban">
                Заблокировать
              </button>
            )}
            <button className="chip" onClick={() => resolve(r, "dismissed")}>Отклонить</button>
          </div>
        </article>
      ))}
    </div>
  );
}
