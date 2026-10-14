import { useCallback, useEffect, useState } from "react";
import { TASHKENT_DISTRICTS, formatUzs, type AdminSettings, type CourierTariff, type District } from "@ishonch/shared/client";
import { ApiError, type AdminUser, type Api, type PriceRow } from "../../api";
import { confirmDialog } from "../../dialogs";
import { districtName } from "./labels";

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Ошибка");

/** Lookup by Telegram id (from a complaint, an operator card or the user), ban / unban, banned list. */
export function Users({ api }: { api: Api }) {
  const [query, setQuery] = useState("");
  const [user, setUser] = useState<AdminUser | null>(null);
  const [reason, setReason] = useState("");
  const [banned, setBanned] = useState<Awaited<ReturnType<Api["bannedUsers"]>>>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const loadBanned = useCallback(() => api.bannedUsers().then(setBanned).catch(() => undefined), [api]);
  useEffect(() => void loadBanned(), [loadBanned]);

  async function find() {
    setMsg(null);
    setUser(null);
    try {
      setUser(await api.findUser(query.trim()));
    } catch {
      setMsg("Не найден");
    }
  }
  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      setMsg(ok);
      await loadBanned();
      if (user) setUser(await api.findUser(String(user.telegramId)));
    } catch (e) {
      setMsg(errText(e));
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <input inputMode="numeric" placeholder="Telegram ID" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="secondary" onClick={find} disabled={!query.trim()}>
          Найти
        </button>
      </div>
      {msg && <p className="toast" onClick={() => setMsg(null)}>{msg}</p>}
      {user && (
        <section className="card stack" data-testid="admin-user">
          <strong>
            {user.telegramId} · {user.role}
          </strong>
          <span className="hint">С {new Date(user.createdAt).toLocaleDateString("ru-RU")}</span>
          <span className="hint">
            Активных объявлений: {user.activeListings} · рейтинг {user.rating.avg ?? "—"} ({user.rating.count})
          </span>
          {user.bannedAt ? (
            <>
              <span className="error">Заблокирован: {user.banReason}</span>
              <button className="secondary" onClick={() => act(() => api.unban(user.id), "Разблокирован")}>
                Разблокировать
              </button>
            </>
          ) : (
            user.role !== "admin" && (
              <>
                <input placeholder="Причина блокировки" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button
                  className="secondary danger"
                  disabled={reason.trim().length < 3}
                  onClick={async () =>
                    (await confirmDialog("Заблокировать? Объявления уйдут в архив, открытые заказы отменятся.")) &&
                    act(() => api.ban(user.id, reason.trim()), "Заблокирован")
                  }
                >
                  ⛔️ Заблокировать
                </button>
              </>
            )
          )}
        </section>
      )}
      <h3>Заблокированные</h3>
      {banned.length === 0 && <p className="hint">Нет</p>}
      <ul className="plain">
        {banned.map((b) => (
          <li key={b.id} className="row between">
            <span>
              {b.telegramId} <span className="hint">— {b.banReason}</span>
            </span>
            <button className="link" onClick={() => act(() => api.unban(b.id), "Разблокирован")}>
              снять
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Price reference (CSV import) and courier tariffs. */
export function References({ api }: { api: Api }) {
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [filter, setFilter] = useState("");
  const [csv, setCsv] = useState("");
  const [tariffs, setTariffs] = useState<Array<Omit<CourierTariff, "id">>>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPrices(await api.prices());
    setTariffs((await api.tariffs()).map(({ id: _id, ...t }) => t));
  }, [api]);
  useEffect(() => void load().catch((e) => setMsg(errText(e))), [load]);

  async function importCsv() {
    try {
      const r = await api.importPrices(csv);
      setMsg(`Импортировано: ${r.imported}${r.errors.length ? `. Ошибки: ${r.errors.join("; ")}` : ""}`);
      setCsv("");
      await load();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  async function saveTariffs() {
    try {
      await api.saveTariffs(tariffs);
      setMsg("Тарифы сохранены");
      await load();
    } catch (e) {
      setMsg(errText(e));
    }
  }

  const setT = (i: number, patch: Partial<Omit<CourierTariff, "id">>) => setTariffs(tariffs.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const shown = prices.filter((p) => p.modelKey.includes(filter.toLowerCase()));

  return (
    <div className="stack">
      {msg && <p className="toast" onClick={() => setMsg(null)}>{msg}</p>}

      <section className="card stack">
        <h3>Тарифы доставки</h3>
        <p className="hint">Выбирается самая точная строка: пара районов → «куда» → «откуда» → по умолчанию (оба поля «любой»).</p>
        {tariffs.map((t, i) => (
          <div key={i} className="stack tariff-row">
            <div className="row">
              <input value={t.name} onChange={(e) => setT(i, { name: e.target.value })} placeholder="Название" />
              <label className="check-row">
                <input type="checkbox" checked={t.active} onChange={(e) => setT(i, { active: e.target.checked })} />
                вкл
              </label>
            </div>
            <div className="row">
              <DistrictSelect value={t.fromDistrict} onChange={(v) => setT(i, { fromDistrict: v })} label="откуда" />
              <DistrictSelect value={t.toDistrict} onChange={(v) => setT(i, { toDistrict: v })} label="куда" />
            </div>
            <div className="row">
              <label className="field">
                Цена, сум
                <input type="number" value={t.price} onChange={(e) => setT(i, { price: Number(e.target.value) })} />
              </label>
              <label className="field">
                % за наличные
                <input type="number" step="0.5" value={t.codFeePct} onChange={(e) => setT(i, { codFeePct: Number(e.target.value) })} />
              </label>
              <button className="link danger" onClick={() => setTariffs(tariffs.filter((_, j) => j !== i))} aria-label="Удалить">
                ✕
              </button>
            </div>
          </div>
        ))}
        <button
          className="link"
          onClick={() => setTariffs([...tariffs, { name: "Новый", fromDistrict: null, toDistrict: null, price: 30_000, codFeePct: 1, active: true }])}
        >
          + строка
        </button>
        <button className="primary" onClick={saveTariffs}>
          Сохранить тарифы
        </button>
      </section>

      <section className="card stack">
        <h3>Справочник цен ({prices.length})</h3>
        <textarea
          rows={4}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={"model_key,price_min,price_median,price_max\napple iphone 13 128gb,5200000,5800000,6500000"}
        />
        <button className="secondary" disabled={!csv.trim()} onClick={importCsv}>
          Импорт CSV
        </button>
        <input placeholder="Фильтр по модели" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Модель</th>
                <th className="num">Мин</th>
                <th className="num">Медиана</th>
                <th className="num">Макс</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 100).map((p) => (
                <tr key={p.id}>
                  <td>{p.modelKey}</td>
                  <td className="num">{formatUzs(p.priceMin).replace(" UZS", "")}</td>
                  <td className="num">{formatUzs(p.priceMedian).replace(" UZS", "")}</td>
                  <td className="num">{formatUzs(p.priceMax).replace(" UZS", "")}</td>
                  <td>
                    <button
                      className="link danger"
                      aria-label="Удалить"
                      onClick={async () => (await confirmDialog(`Удалить ${p.modelKey}?`)) && api.deletePrice(p.id).then(load)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function DistrictSelect({ value, onChange, label }: { value: District | null; onChange: (v: District | null) => void; label: string }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange((e.target.value || null) as District | null)} aria-label={label}>
      <option value="">{label}: любой</option>
      {TASHKENT_DISTRICTS.map((d) => (
        <option key={d} value={d}>
          {districtName(d)}
        </option>
      ))}
    </select>
  );
}

const SETTING_LABEL: Record<keyof AdminSettings, string> = {
  checks_per_day: "Проверок в день на пользователя",
  assistant_per_day: "Запросов к AI-помощнику в день",
  usd_rate: "Курс USD, сум",
  ai_monthly_limit_usd: "Лимит расходов на AI в месяц, $",
  ai_strong_monthly_limit_usd: "Из них на AI-помощника (сильная модель), $",
  complaints_to_hide: "Жалоб от разных людей, чтобы скрыть объявление",
  listing_ai_per_day: "AI-черновиков и генераций текста в день на продавца",
};

export function Settings({ api }: { api: Api }) {
  const [s, setS] = useState<AdminSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => void api.settings().then(setS).catch((e) => setMsg(errText(e))), [api]);
  if (!s) return <p className="hint center">{msg ?? "Загрузка…"}</p>;
  return (
    <div className="stack">
      {(Object.keys(SETTING_LABEL) as Array<keyof AdminSettings>).map((k) => (
        <label key={k} className="field">
          {SETTING_LABEL[k]}
          <input type="number" value={s[k]} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} data-testid={`setting-${k}`} />
        </label>
      ))}
      <p className="hint">Применяется в течение минуты, без перезапуска.</p>
      {msg && <p className="toast" onClick={() => setMsg(null)}>{msg}</p>}
      <button
        className="primary"
        onClick={() =>
          api
            .saveSettings(s)
            .then((r) => (setS(r), setMsg("Сохранено")))
            .catch((e) => setMsg(e instanceof ApiError && e.code === "bad_request" ? "Проверьте значения" : errText(e)))
        }
      >
        Сохранить
      </button>
    </div>
  );
}
