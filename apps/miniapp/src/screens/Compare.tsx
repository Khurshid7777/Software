import { useEffect, useState, type ReactNode } from "react";
import {
  COMPARE_MAX,
  CONDITION_RANK,
  formatUzs,
  listingTitle,
  type CatalogItem,
  type CompareResponse,
  type Grade,
} from "@ishonch/shared/client";
import { ApiError, photoUrl, type Api } from "../api";
import { Empty } from "../components/Empty";
import { Icon } from "../components/Icon";
import { GradeChip } from "../components/Passport";
import { clearCompare, removeFromCompare, useCompare } from "../compare";
import { useLang, useT } from "../i18n";

const GRADE_SCORE: Record<Grade, number> = { A: 3, B: 2, C: 1, D: 0 };
const TRUST_SCORE = { high: 2, medium: 1, low: 0 } as const;

interface Cell {
  node: ReactNode;
  /** Higher is better; null = not comparable (missing). The best cell of a row is highlighted. */
  score: number | null;
}
interface Row {
  key: string;
  label: string;
  cells: Cell[];
}

/**
 * «Versus»: up to COMPARE_MAX listings side by side. Every row comes from the listing data (price, market,
 * grade, checklist facts, the video passport, the courier's inspection, the seller), never from the AI; the AI
 * only adds an opinion on request, through the same /assistant/compare the buyer assistant uses.
 */
export function Compare({ api, onOpen, onCatalog }: { api: Api; onOpen: (id: string) => void; onCatalog: () => void }) {
  const t = useT();
  const lang = useLang();
  const ids = useCompare();
  const key = ids.join(",");
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [ai, setAi] = useState<CompareResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setAi(null);
    if (!ids.length) {
      setItems([]);
      return;
    }
    api
      .catalogBatch(ids, { passport: true })
      .then((list) => {
        if (!current) return;
        setItems(list);
        // Sold or hidden since it was added: drop it quietly.
        for (const id of ids) if (!list.some((i) => i.listing.id === id)) removeFromCompare(id);
      })
      .catch(() => current && setItems([]));
    return () => {
      current = false;
    };
  }, [api, key]); // eslint-disable-line react-hooks/exhaustive-deps

  async function askAi() {
    if (!items || items.length < 2 || busy) return;
    setBusy(true);
    setError(null);
    try {
      setAi(await api.compare(items.map((i) => i.listing.id), lang));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  if (items === null) return <p className="center hint">{t("common.loading")}</p>;
  if (!items.length) {
    return (
      <div className="stack">
        <h1>{t("versus.title")}</h1>
        <Empty icon="⚖️" image={`${import.meta.env.BASE_URL}art/empty-compare.webp`} title={t("versus.empty_title")} text={t("versus.empty_text", { n: COMPARE_MAX })} />
        <button className="primary" onClick={onCatalog} data-testid="compare-catalog">
          {t("versus.to_catalog")}
        </button>
      </div>
    );
  }

  const yes = t("versus.yes");
  const no = t("versus.no");
  const unknown = <span className="hint">{t("versus.unknown")}</span>;
  const rows: Row[] = [
    {
      key: "price",
      label: t("compare.price"),
      cells: items.map(({ listing: l }) => ({ node: l.price ? <strong>{formatUzs(l.price)}</strong> : "—", score: l.price ? -l.price : null })),
    },
    {
      key: "market",
      label: t("compare.market"),
      cells: items.map((i) => {
        const m = i.market;
        if (!m || m.verdict === "unknown" || m.diffPct == null) return { node: unknown, score: null };
        return { node: <span className={`market market-${m.verdict}`}>{t(`market.${m.verdict}`, { pct: Math.abs(m.diffPct) })}</span>, score: -m.diffPct };
      }),
    },
    {
      key: "grade",
      label: t("versus.row.grade"),
      cells: items.map(({ listing: l }) => ({
        node: l.grade ? (
          <span className="row">
            <GradeChip grade={l.grade} /> {t(`passport.grade_name.${l.grade}`)}
          </span>
        ) : (
          unknown
        ),
        score: l.grade ? GRADE_SCORE[l.grade] : null,
      })),
    },
    {
      key: "condition",
      label: t("compare.condition"),
      cells: items.map(({ listing: l }) => ({ node: l.condition ? t(`condition.${l.condition}`) : unknown, score: l.condition ? CONDITION_RANK[l.condition] : null })),
    },
    {
      key: "battery",
      label: t("versus.row.battery"),
      cells: items.map(({ listing: l }) => {
        const pct = l.checklist.batteryPct;
        return { node: pct != null ? `${pct}%` : unknown, score: pct ?? null };
      }),
    },
    {
      key: "age",
      label: t("versus.row.age"),
      cells: items.map(({ listing: l }) => {
        const y = l.checklist.ageYears;
        return { node: y == null ? unknown : y === 0 ? t("checklist.age_new") : t("checklist.age", { n: y }), score: y == null ? null : -y };
      }),
    },
    {
      key: "repairs",
      label: t("versus.row.repairs"),
      cells: items.map(({ listing: l }) => {
        const r = l.checklist.repairs ?? [];
        if (!r.length) return { node: unknown, score: null };
        const none = r.every((x) => x === "none");
        return { node: none ? t("versus.no_repairs") : t("versus.repaired"), score: none ? 1 : 0 };
      }),
    },
    {
      key: "account",
      label: t("versus.row.account"),
      cells: items.map(({ listing: l }) => {
        const a = l.checklist.accountUnlocked;
        return { node: a == null ? unknown : a ? yes : no, score: a == null ? null : a ? 1 : 0 };
      }),
    },
    {
      key: "video",
      label: t("versus.row.video"),
      cells: items.map(({ listing: l }) => {
        if (!l.video) return { node: no, score: 0 };
        const v = l.videoCheck?.verdict;
        if (v === "pass") return { node: <span className="ok-text"><Icon name="ok" /> {t("versus.video_ai")}</span>, score: 3 };
        if (v === "warn" || v === "fail") return { node: t("versus.video_partial"), score: 1 };
        return { node: t("versus.video_seller"), score: 2 };
      }),
    },
    {
      key: "verified",
      label: t("versus.row.verified"),
      cells: items.map(({ listing: l }) => ({ node: l.verified ? <span className="ok-text"><Icon name="ok" /> {yes}</span> : no, score: l.verified ? 1 : 0 })),
    },
    {
      key: "passport",
      label: t("versus.row.passport"),
      cells: items.map((i) => {
        const p = i.passport;
        return { node: p ? t("versus.passed", { passed: p.passed, total: p.total }) : "—", score: p && p.total ? p.passed / p.total : null };
      }),
    },
    {
      key: "photos",
      label: t("versus.row.photos"),
      cells: items.map(({ listing: l }) => ({ node: String(l.photos.length), score: l.photos.length })),
    },
    {
      key: "seller",
      label: t("compare.seller"),
      cells: items.map((i) => ({
        node: (
          <span className={`trust trust-${i.trust}`}>
            {i.listing.seller?.shop?.verified ? "✔️ " : ""}
            {t(`trust.${i.trust}`)}
          </span>
        ),
        score: TRUST_SCORE[i.trust],
      })),
    },
    {
      key: "rating",
      label: t("versus.row.rating"),
      cells: items.map(({ listing: l }) => {
        const r = l.seller?.rating;
        return r && r.count > 0 && r.avg != null ? { node: `★ ${r.avg} (${r.count})`, score: r.avg } : { node: <span className="hint">{t("versus.no_reviews")}</span>, score: null };
      }),
    },
    {
      key: "district",
      label: t("compare.district"),
      cells: items.map(({ listing: l }) => ({ node: l.district ? t(`district.${l.district}`) : unknown, score: null })),
    },
  ];
  // The best cell of a row is highlighted only when the row actually differs.
  const bestOf = (row: Row) => {
    const scores = row.cells.map((c) => c.score).filter((s): s is number => s !== null);
    if (scores.length < 2 || new Set(scores).size < 2) return null;
    return Math.max(...scores);
  };

  return (
    <div className="stack versus" data-testid="compare">
      <div className="row between">
        <h1>{t("versus.title")}</h1>
        <button className="link" onClick={clearCompare} data-testid="compare-clear">
          {t("versus.clear")}
        </button>
      </div>
      <p className="hint">{t("versus.intro")}</p>

      <div className="table-wrap versus-wrap">
        <table className="versus-table">
          <thead>
            <tr>
              <th />
              {items.map((i) => (
                <th key={i.listing.id}>
                  <div className="versus-item">
                    <button className="versus-remove" aria-label={t("versus.remove")} onClick={() => removeFromCompare(i.listing.id)} data-testid="compare-remove">
                      <Icon name="close" />
                    </button>
                    <button className="versus-open" onClick={() => onOpen(i.listing.id)}>
                      <span className="versus-photo">
                        {i.listing.photos[0] ? <img src={photoUrl(i.listing.photos[0].url, 480)} alt="" width={120} height={120} /> : <span className="no-photo">📦</span>}
                      </span>
                      <span className="versus-title">{listingTitle(i.listing, lang)}</span>
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const best = bestOf(r);
              return (
                <tr key={r.key} data-testid={`compare-row-${r.key}`}>
                  <th>{r.label}</th>
                  {r.cells.map((c, i) => (
                    <td key={i} className={best !== null && c.score === best ? "best" : ""}>
                      {c.node}
                    </td>
                  ))}
                </tr>
              );
            })}
            {ai && (
              <tr className="versus-ai" data-testid="compare-ai-row">
                <th>{t("compare.best_for")}</th>
                {items.map((i) => (
                  <td key={i.listing.id}>{ai.bestFor[i.listing.id] ?? "—"}</td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {ai ? (
        <section className="card stack" data-testid="compare-ai">
          <h3>
            <Icon name="sparkles" /> {t("versus.ai_verdict")}
          </h3>
          <p>{ai.summary}</p>
          <p className="disclaimer">{t("ai.disclaimer")}</p>
        </section>
      ) : (
        items.length >= 2 && (
          <div className="stack-tight">
            <button className="secondary" onClick={askAi} disabled={busy} data-testid="compare-ask-ai">
              <Icon name="sparkles" /> {busy ? t("assistant.thinking") : t("versus.ask_ai")}
            </button>
            <p className="hint center">{t("versus.ai_hint")}</p>
          </div>
        )
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
