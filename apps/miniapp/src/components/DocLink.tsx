import type { ReactNode } from "react";
import { openLink } from "@telegram-apps/sdk-react";

/** External document: Telegram's in-app browser when available (target=_blank does nothing in some clients). */
export function DocLink({ url, className, children }: { url: string; className?: string; children: ReactNode }) {
  return (
    <a
      className={className}
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (openLink.isAvailable()) {
          e.preventDefault();
          openLink(url);
        }
      }}
    >
      {children}
    </a>
  );
}
