import type { ListingSeller } from "@ishonch/shared/client";
import { useLang, useT } from "../i18n";
import { Icon } from "./Icon";

interface Fact {
  key: string;
  ok: boolean | null;
  text: string;
}

/**
 * «Что известно о продавце»: every line is a fact from Ishonch's own data, green when it speaks for the seller and
 * grey when there is simply nothing yet (a new seller is not a bad one). Nothing here is the seller's own claim.
 */
export function SellerFacts({ seller: s }: { seller: ListingSeller }) {
  const t = useT();
  const lang = useLang();
  const since = new Date(s.registeredAt).toLocaleDateString(lang === "ru" ? "ru-RU" : "uz-UZ", { month: "long", year: "numeric" });
  const facts: Fact[] = [
    { key: "phone", ok: true, text: t("sfact.phone") },
    { key: "since", ok: null, text: t("sfact.since", { date: since }) },
  ];
  if (s.shop?.verified) facts.push({ key: "shop", ok: true, text: t("sfact.shop", { name: s.shop.name }) });
  facts.push(
    s.platformSales > 0
      ? { key: "sales", ok: true, text: t("sfact.sales", { n: s.platformSales }) }
      : { key: "sales", ok: null, text: t("sfact.no_sales") },
  );
  const { passed, failed } = s.inspections;
  if (passed + failed > 0) facts.push({ key: "inspections", ok: failed === 0 || passed > failed, text: t("sfact.inspections", { passed, failed }) });
  facts.push(
    s.disputesLost > 0
      ? { key: "disputes", ok: false, text: t("sfact.disputes_lost", { n: s.disputesLost }) }
      : { key: "disputes", ok: s.platformSales > 0 ? true : null, text: t("sfact.no_disputes") },
  );
  if (s.responseMinutes != null) {
    facts.push({
      key: "response",
      ok: s.responseMinutes <= 60,
      text: s.responseMinutes < 60 ? t("listing.response_min", { n: s.responseMinutes }) : t("listing.response_hours", { n: Math.round(s.responseMinutes / 60) }),
    });
  }
  return (
    <ul className="plain seller-facts" data-testid="seller-facts">
      {facts.map((f) => (
        <li key={f.key} className={f.ok === false ? "bad" : f.ok ? "ok" : ""} data-testid={f.key === "response" ? "response-time" : `sfact-${f.key}`}>
          <Icon name={f.ok === false ? "alert" : f.ok ? "ok" : "clock"} /> {f.text}
        </li>
      ))}
    </ul>
  );
}
