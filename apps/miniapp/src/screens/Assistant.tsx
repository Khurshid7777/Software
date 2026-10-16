import { useState } from "react";
import type { AssistantMessage, AssistantResponse, CatalogFilters, CompareResponse } from "@ishonch/shared/client";
import { ApiError, type Api } from "../api";
import { ItemCard } from "../components/ItemCard";
import { useLang, useT } from "../i18n";

type Turn = { role: "user"; content: string } | { role: "assistant"; content: string; response?: AssistantResponse };

export function Assistant({ api, onOpen }: { api: Api; onOpen: (id: string) => void }) {
  const t = useT();
  const lang = useLang();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<CompareResponse | null>(null);
  const [saved, setSaved] = useState(false);

  const [failedText, setFailedText] = useState<string | null>(null);

  async function send(retry?: string) {
    const text = (retry ?? input).trim();
    if (!text || busy) return;
    // A retry re-sends the same message instead of adding it twice.
    const base = retry ? turns.slice(0, -1) : turns;
    const next: Turn[] = [...base, { role: "user", content: text }];
    setFailedText(null);
    setTurns(next);
    setInput("");
    setBusy(true);
    setError(null);
    setSelected([]);
    setComparison(null);
    setSaved(false);
    try {
      const history: AssistantMessage[] = next.map((m) => ({ role: m.role, content: m.content }));
      const res = await api.assistant(history, lang);
      const content = [res.reply, ...res.questions].join("\n");
      setTurns([...next, { role: "assistant", content, response: res }]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
      setFailedText(text);
    } finally {
      setBusy(false);
    }
  }

  async function compare() {
    setBusy(true);
    try {
      const needs = turns.filter((m) => m.role === "user").map((m) => m.content).join(". ");
      setComparison(await api.compare(selected, lang, needs));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function subscribe(filters: CatalogFilters) {
    try {
      await api.saveSearch(filters);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    }
  }

  const examples = [t("assistant.example1"), t("assistant.example2"), t("assistant.example3")];

  const last = [...turns].reverse().find((m) => m.role === "assistant") as Extract<Turn, { role: "assistant" }> | undefined;

  return (
    <div className="stack">
      <h1>🤖 {t("assistant.title")}</h1>
      {turns.length === 0 && (
        <>
          <p className="card">{t("assistant.intro")}</p>
          <div className="chips">
            {examples.map((x) => (
              <button key={x} className="chip" onClick={() => setInput(x)}>
                {x}
              </button>
            ))}
          </div>
        </>
      )}

      {turns.map((m, i) => (
        <div key={i} className={`bubble ${m.role}`}>
          {m.role === "assistant" && m.response?.questions.length ? (
            <>
              <p>{m.response.reply}</p>
              <ul>
                {m.response.questions.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>{m.content}</p>
          )}
        </div>
      ))}

      {last?.response?.kind === "results" && (
        <div className="stack" data-testid="assistant-results">
          {last.response.options.map((o) => (
            <div key={o.item.listing.id} className="stack option">
              <ItemCard
                item={o.item}
                onOpen={() => onOpen(o.item.listing.id)}
                selected={selected.includes(o.item.listing.id)}
                onSelect={(on) =>
                  setSelected((s) => (on ? (s.length < 3 ? [...s, o.item.listing.id] : s) : s.filter((x) => x !== o.item.listing.id)))
                }
              />
              {o.fit && <p className="hint">💡 {o.fit}</p>}
              <div className="two-col">
                <ul className="pros">{o.pros.map((p) => <li key={p}>✅ {p}</li>)}</ul>
                <ul className="cons">{o.cons.map((c) => <li key={c}>⚠️ {c}</li>)}</ul>
              </div>
            </div>
          ))}
          <p className="hint">{t("assistant.compare_hint")}</p>
          <button className="secondary" disabled={selected.length < 2 || busy} onClick={compare} data-testid="compare">
            {t("assistant.compare", { n: selected.length })}
          </button>
        </div>
      )}

      {last?.response?.kind === "no_results" && last.response.filters && (
        <button className="secondary" onClick={() => subscribe(last.response!.filters!)} disabled={saved}>
          {saved ? t("catalog.search_saved") : t("assistant.subscribe")}
        </button>
      )}

      {comparison && (
        <div className="card stack" data-testid="comparison">
          <h3>{t("assistant.compare_title")}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th />
                  {comparison.items.map((i) => (
                    <th key={i.listing.id}>{lang === "ru" ? i.listing.titleRu : i.listing.titleUz}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((r) => (
                  <tr key={r.label}>
                    <th>{r.label}</th>
                    {r.values.map((v, i) => (
                      <td key={i}>{v}</td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <th>{t("compare.best_for")}</th>
                  {comparison.items.map((i) => (
                    <td key={i.listing.id}>{comparison.bestFor[i.listing.id] ?? "—"}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p>{comparison.summary}</p>
        </div>
      )}

      {busy && <p className="hint center">{t("assistant.thinking")}</p>}
      {error && (
        <div className="row between">
          <p className="error">{error}</p>
          {failedText && (
            <button className="chip" onClick={() => void send(failedText)}>
              ↻ {t("common.retry")}
            </button>
          )}
        </div>
      )}

      <div className="composer">
        <textarea
          rows={2}
          placeholder={t("assistant.placeholder")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a new line (desktop Telegram); phones use the button.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          enterKeyHint="send"
          data-testid="assistant-input"
        />
        <button className="primary" onClick={() => void send()} disabled={busy || !input.trim()} data-testid="assistant-send">
          ➤
        </button>
      </div>
      <p className="disclaimer">{t("ai.disclaimer")}</p>
    </div>
  );
}
