import type { FaqId } from "@ishonch/shared/client";
import { useT } from "../i18n";
import { Icon } from "./Icon";

/** A small «Вопросы и ответы» link next to a screen where people hesitate; it opens the matching answer. */
export function FaqLink({ id, onOpen }: { id: FaqId; onOpen?: (id: FaqId) => void }) {
  const t = useT();
  if (!onOpen) return null;
  return (
    <button className="faq-link" onClick={() => onOpen(id)} data-testid={`faq-link-${id}`}>
      <Icon name="chat" /> {t(`faq.${id}.q`)}
    </button>
  );
}
