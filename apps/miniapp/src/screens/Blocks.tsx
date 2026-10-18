import { useEffect, useState } from "react";
import { ApiError, type Api } from "../api";
import { Empty } from "../components/Empty";
import { LoadError } from "../components/LoadError";
import { Toast } from "../components/Toast";
import { useT } from "../i18n";

type Block = { userId: string; title: string | null; role: "buyer" | "seller" | null; createdAt: string };

/** People the user blocked in the masked chat (stage 19), shown by the listing where they met. */
export function Blocks({ api }: { api: Api }) {
  const t = useT();
  const [items, setItems] = useState<Block[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const load = () => {
    setFailed(false);
    api
      .blocks()
      .then(setItems)
      .catch(() => (setItems([]), setFailed(true)));
  };
  useEffect(load, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack" data-testid="blocks">
      <h1>{t("blocks.title")}</h1>
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
      {items === null && <p className="hint center">{t("common.loading")}</p>}
      {failed && <LoadError onRetry={load} />}
      {items?.length === 0 && !failed && <Empty icon="🕊" title={t("blocks.empty")} />}
      {items?.map((b) => (
        <div key={b.userId} className="card row between" data-testid="block-row">
          <span>{b.title ? t(b.role === "seller" ? "blocks.seller" : "blocks.buyer", { title: b.title }) : t("blocks.unknown")}</span>
          <button
            className="link"
            onClick={() =>
              api
                .unblock(b.userId)
                .then(() => setItems((list) => list?.filter((x) => x.userId !== b.userId) ?? null))
                .catch((e) => setToast(e instanceof ApiError ? e.message : t("common.error")))
            }
            data-testid="unblock"
          >
            {t("blocks.unblock")}
          </button>
        </div>
      ))}
    </div>
  );
}
