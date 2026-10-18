import { MAX_ATTEMPTS } from "../../jobs/queue.js";
import { sql, type SQL } from "drizzle-orm";
import { formatUzs, type AdminMetrics, type FunnelStep } from "@ishonch/shared";
import { startOfMonthUtc, startOfTashkentDay, type Repo } from "../../db/repo.js";

const DAY = 24 * 3600_000;
/** Calendar days are Tashkent days (UTC+5) everywhere in reports. */
const TASHKENT_DAY = (col: SQL) => sql`to_char(${col} at time zone 'Asia/Tashkent', 'YYYY-MM-DD')`;

type Row = Record<string, unknown>;
/** Raw `db.execute` does not serialise Date parameters: pass ISO strings cast to timestamptz. */
const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const num = (v: unknown) => Number(v ?? 0);

export const BUYER_FUNNEL = [
  "terms_accepted",
  "catalog_search",
  "listing_viewed",
  "buyer_contacted_seller",
  "order_created",
  "order_delivered",
  "review_created",
] as const;
export const SELLER_FUNNEL = ["listing_draft_created", "listing_published", "order_confirmed", "listing_sold_platform"] as const;

/**
 * Admin reports straight from the operational tables and `events`.
 * Funnel steps count distinct users who did the step within the period (not a strict sequence),
 * which is honest for small numbers and needs no session stitching.
 */
export class MetricsService {
  constructor(private repo: Repo) {}

  private get db() {
    return this.repo.db;
  }

  private async rows(q: SQL): Promise<Row[]> {
    return (await this.db.execute(q)) as unknown as Row[];
  }

  private async one(q: SQL): Promise<Row> {
    return (await this.rows(q))[0] ?? {};
  }

  async overview(days: number, now = new Date()): Promise<AdminMetrics> {
    const to = now;
    const from = new Date(startOfTashkentDay(now).getTime() - (days - 1) * DAY);

    const users = await this.one(sql`
      select count(*) as total,
        count(*) filter (where created_at >= ${ts(from)}) as new,
        count(*) filter (where banned_at is not null) as banned,
        count(*) filter (where role in ('seller', 'shop')) as sellers
      from users where role <> 'deleted'`);
    const active = await this.one(sql`
      select count(distinct user_id) as n from events where created_at >= ${ts(from)} and user_id is not null`);

    // ---- funnels: distinct users per event within the period ----
    const eventUsers = await this.rows(sql`
      select name, count(distinct user_id) as n from events
      where created_at >= ${ts(from)} and user_id is not null
        and name in (${sql.join([...BUYER_FUNNEL, "listing_draft_created", "listing_published", "check_created"].map((n) => sql`${n}`), sql`, `)})
      group by name`);
    const byEvent = new Map(eventUsers.map((r) => [String(r.name), num(r.n)]));
    // Order steps from the orders table (exact, also for history before events existed).
    const sellerOrders = await this.one(sql`
      select count(distinct seller_user_id)
               filter (where exists (select 1 from order_events e where e.order_id = orders.id and e.status = 'confirmed')) as confirmed,
             count(distinct seller_user_id) filter (where status = 'delivered') as sold
      from orders where created_at >= ${ts(from)}`);
    // Meetings (stage 18): distinct buyers per step, from the meetings table.
    const meetings = await this.one(sql`
      select count(distinct buyer_user_id) as requested,
        count(distinct buyer_user_id) filter (where status in ('accepted', 'bought', 'not_bought', 'seller_no_show', 'buyer_no_show')) as accepted,
        count(distinct buyer_user_id) filter (where status = 'bought') as bought
      from meetings where created_at >= ${ts(from)}`);
    const funnel = (steps: Array<[string, number]>): FunnelStep[] =>
      steps.map(([step, users], i) => ({
        step,
        users,
        conversionPct: i === 0 || !steps[i - 1]![1] ? null : Math.round((users / steps[i - 1]![1]) * 100),
      }));

    // ---- listings ----
    const listings = await this.one(sql`
      select count(*) filter (where status = 'active' and (expires_at is null or expires_at > now())) as active,
        count(*) filter (where status = 'pending') as pending,
        count(*) filter (where status = 'reserved') as reserved,
        count(*) filter (where status = 'sold' and sold_at >= ${ts(from)}) as sold,
        count(*) filter (where status = 'sold' and sold_at >= ${ts(from)} and sold_via = 'platform') as sold_platform,
        count(*) filter (where published_at >= ${ts(from)}) as published
      from listings`);
    const moderation = await this.rows(sql`
      select props->>'decision' as decision, count(*) as n from events
      where name = 'listing_moderation' and created_at >= ${ts(from)} group by 1`);
    const published = num(
      (await this.one(sql`select count(*) as n from events where name = 'listing_published' and created_at >= ${ts(from)}`)).n,
    );
    const complaints = await this.one(sql`
      select count(*) filter (where resolved_at is null) as open,
        count(*) filter (where created_at >= ${ts(from)}) as period,
        (select count(*) from events where name = 'listing_hidden_by_complaints' and created_at >= ${ts(from)}) as hidden
      from complaints`);

    // ---- orders ----
    const orders = await this.one(sql`
      select count(*) as created,
        count(*) filter (where status = 'delivered') as delivered,
        count(*) filter (where status = 'returned') as returned,
        count(*) filter (where status = 'cancelled') as cancelled,
        count(*) filter (where status in ('new', 'confirmed', 'courier_assigned', 'picked_up')) as open,
        coalesce(sum((quote->>'itemPrice')::bigint) filter (where status = 'delivered'), 0) as gmv,
        coalesce(sum((quote->>'deliveryFee')::bigint + coalesce((quote->>'liftFee')::bigint, 0) + (quote->>'codFee')::bigint) filter (where status = 'delivered'), 0) as fees,
        avg(extract(epoch from delivered_at - created_at) / 3600) filter (where status = 'delivered') as hours
      from orders where created_at >= ${ts(from)}`);
    const cancelReasons = await this.rows(sql`
      select coalesce(cancel_reason, 'unknown') as reason, count(*) as n from orders
      where created_at >= ${ts(from)} and status = 'cancelled' group by 1 order by 2 desc`);
    const byMode = await this.rows(sql`
      select mode, count(*) as n, count(*) filter (where status = 'delivered') as delivered from orders
      where created_at >= ${ts(from)} group by 1 order by 2 desc`);
    const stuck = await this.one(sql`
      select count(*) as n from orders
      where status in ('new', 'confirmed', 'courier_assigned', 'picked_up') and updated_at < now() - interval '24 hours'`);

    // ---- AI ----
    const ai = await this.rows(sql`
      select feature, count(*) as calls, coalesce(sum(cost_usd), 0) as usd from ai_usage
      where created_at >= ${ts(from)} group by 1 order by 3 desc`);
    const month = await this.repo.aiSpendSince(startOfMonthUtc(now));
    const limit = await this.repo.getSetting("ai_monthly_limit_usd", 50);

    // ---- daily series ----
    // One grouped query per table over the range (indexable), merged onto the calendar in code.
    const perDay = async (q: SQL) => new Map((await this.rows(q)).map((r) => [String(r.day), num(r.n)]));
    const [newUsers, checksByDay, publishedByDay, ordersByDay, deliveredByDay, aiByDay] = await Promise.all([
      perDay(sql`select ${TASHKENT_DAY(sql`created_at`)} as day, count(*) as n from users where created_at >= ${ts(from)} group by 1`),
      perDay(sql`select ${TASHKENT_DAY(sql`created_at`)} as day, count(*) as n from checks where created_at >= ${ts(from)} group by 1`),
      perDay(sql`select ${TASHKENT_DAY(sql`created_at`)} as day, count(*) as n from events
        where name = 'listing_published' and created_at >= ${ts(from)} group by 1`),
      perDay(sql`select ${TASHKENT_DAY(sql`created_at`)} as day, count(*) as n from orders where created_at >= ${ts(from)} group by 1`),
      perDay(sql`select ${TASHKENT_DAY(sql`delivered_at`)} as day, count(*) as n from orders where delivered_at >= ${ts(from)} group by 1`),
      perDay(sql`select ${TASHKENT_DAY(sql`created_at`)} as day, sum(cost_usd) as n from ai_usage where created_at >= ${ts(from)} group by 1`),
    ]);
    const calendar: string[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
      calendar.push(new Date(t + 5 * 3600_000).toISOString().slice(0, 10));
    }
    const daily = calendar.map((day) => ({
      day,
      new_users: newUsers.get(day),
      checks: checksByDay.get(day),
      published: publishedByDay.get(day),
      orders: ordersByDay.get(day),
      delivered: deliveredByDay.get(day),
      ai_usd: aiByDay.get(day),
    }));

    const delivered = num(orders.delivered);
    const returned = num(orders.returned);
    const decisions = Object.fromEntries(moderation.map((r) => [String(r.decision), num(r.n)]));
    const system = await this.one(sql`
      select count(*) filter (where done_at is null and attempts < ${MAX_ATTEMPTS}) as queued,
             count(*) filter (where done_at is null and attempts >= ${MAX_ATTEMPTS}) as failed,
             (select count(*) from disputes where status = 'open') as disputes
      from jobs`);
    return {
      period: { from: from.toISOString(), to: to.toISOString(), days },
      users: {
        total: num(users.total),
        new: num(users.new),
        active: num(active.n),
        sellers: num(users.sellers),
        banned: num(users.banned),
      },
      checks: { users: byEvent.get("check_created") ?? 0 },
      meetingFunnel: funnel([
        ["buyer_contacted_seller", byEvent.get("buyer_contacted_seller") ?? 0],
        ["meeting_requested", num(meetings.requested)],
        ["meeting_accepted", num(meetings.accepted)],
        ["meeting_bought", num(meetings.bought)],
      ]),
      searchMisses: await this.searchMisses(from, 15),
      buyerFunnel: funnel(BUYER_FUNNEL.map((s) => [s, byEvent.get(s) ?? 0])),
      sellerFunnel: funnel([
        ["listing_draft_created", byEvent.get("listing_draft_created") ?? 0],
        ["listing_published", byEvent.get("listing_published") ?? 0],
        ["order_confirmed", num(sellerOrders.confirmed)],
        ["listing_sold_platform", num(sellerOrders.sold)],
      ]),
      listings: {
        active: num(listings.active),
        pending: num(listings.pending),
        reserved: num(listings.reserved),
        published: num(listings.published),
        sold: num(listings.sold),
        soldPlatform: num(listings.sold_platform),
        moderation: {
          // Approved publications are logged as listing_published; held ones as listing_moderation.
          approved: published,
          needsReview: decisions.needs_review ?? 0,
          rejected: decisions.rejected ?? 0,
        },
        complaints: { open: num(complaints.open), period: num(complaints.period), hiddenListings: num(complaints.hidden) },
      },
      orders: {
        created: num(orders.created),
        open: num(orders.open),
        delivered,
        returned,
        cancelled: num(orders.cancelled),
        /** Refusals at inspection among orders that reached the buyer. */
        returnRatePct: delivered + returned ? Math.round((returned / (delivered + returned)) * 100) : null,
        gmvUzs: num(orders.gmv),
        deliveryFeesUzs: num(orders.fees),
        avgHoursToDeliver: orders.hours == null ? null : Math.round(num(orders.hours) * 10) / 10,
        stuckOver24h: num(stuck.n),
        cancelReasons: cancelReasons.map((r) => ({ reason: String(r.reason), count: num(r.n) })),
        byMode: byMode.map((r) => ({ mode: String(r.mode), count: num(r.n), delivered: num(r.delivered) })),
      },
      ai: {
        periodUsd: round4(ai.reduce((s, r) => s + num(r.usd), 0)),
        monthUsd: round4(month),
        monthlyLimitUsd: limit,
        byFeature: ai.map((r) => ({ feature: String(r.feature), calls: num(r.calls), usd: round4(num(r.usd)) })),
      },
      system: { queuedJobs: num(system.queued), failedJobs: num(system.failed), openDisputes: num(system.disputes) },
      daily: daily.map((r) => ({
        date: String(r.day),
        newUsers: num(r.new_users),
        checks: num(r.checks),
        published: num(r.published),
        orders: num(r.orders),
        delivered: num(r.delivered),
        aiUsd: round4(num(r.ai_usd)),
      })),
    };
  }

  /** Orders report for accounting / courier reconciliation (CSV, `;`-separated for Excel in RU locale). */
  async ordersCsv(days: number, now = new Date()) {
    const from = new Date(startOfTashkentDay(now).getTime() - (days - 1) * DAY);
    const rows = await this.rows(sql`
      select o.id, o.created_at, o.status, o.mode, o.district, o.fee_payer, o.cancel_reason, o.delivered_at,
        o.quote, o.courier_name, l.title_ru,
        (select count(*) from reviews r where r.order_id = o.id) as reviewed
      from orders o left join listings l on l.id = o.listing_id
      where o.created_at >= ${ts(from)} order by o.created_at`);
    const head = [
      "order_id", "created_at", "status", "mode", "district", "item", "item_price", "delivery_fee", "cod_fee",
      "fee_payer", "buyer_pays", "seller_receives", "courier", "delivered_at", "cancel_reason", "reviewed", "vehicle", "lift_fee",
    ];
    const cell = (v: unknown) => {
      let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
      // Seller-controlled text must not run as a formula in Excel (=, +, -, @, tab, CR).
      if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map((r) => {
      const q = (r.quote ?? {}) as Record<string, number | string>;
      return [
        r.id, r.created_at, r.status, r.mode, r.district, r.title_ru, q.itemPrice, q.deliveryFee, q.codFee,
        r.fee_payer, r.mode === "delivery_only" ? q.buyerFee : q.buyerTotal, q.sellerReceives, r.courier_name,
        r.delivered_at, r.cancel_reason, num(r.reviewed) > 0 ? "yes" : "no", q.vehicle ?? "courier", q.liftFee ?? 0,
      ].map(cell).join(";");
    });
    return [head.join(";"), ...lines].join("\n") + "\n";
  }

  /** Morning digest for admins (yesterday, Tashkent time) + what needs attention now. */
  /** Searches with no results since `from`, grouped by the normalised query (stage 21). */
  async searchMisses(from: Date, limit: number, to?: Date) {
    const rows = await this.rows(sql`
      select lower(trim(props->>'q')) as q, count(*) as n, count(distinct user_id) as users
      from events
      where name = 'catalog_search' and created_at >= ${ts(from)} ${to ? sql`and created_at < ${ts(to)}` : sql``}
        and (props->>'results')::int = 0 and coalesce(trim(props->>'q'), '') <> ''
      group by 1 order by n desc, q limit ${limit}`);
    return rows.map((r) => ({ q: String(r.q), count: num(r.n), users: num(r.users) }));
  }

  async digest(now = new Date()) {
    const today = startOfTashkentDay(now);
    const yesterday = new Date(today.getTime() - DAY);
    const y = await this.one(sql`
      select
        (select count(*) from users where created_at >= ${ts(yesterday)} and created_at < ${ts(today)}) as new_users,
        (select count(*) from checks where created_at >= ${ts(yesterday)} and created_at < ${ts(today)}) as checks,
        (select count(*) from events where name = 'listing_published' and created_at >= ${ts(yesterday)} and created_at < ${ts(today)}) as published,
        (select count(*) from orders where created_at >= ${ts(yesterday)} and created_at < ${ts(today)}) as orders,
        (select count(*) from orders where delivered_at >= ${ts(yesterday)} and delivered_at < ${ts(today)}) as delivered,
        (select count(*) from order_events where status = 'returned' and created_at >= ${ts(yesterday)} and created_at < ${ts(today)}) as returned,
        (select coalesce(sum((quote->>'itemPrice')::bigint), 0) from orders where delivered_at >= ${ts(yesterday)} and delivered_at < ${ts(today)}) as gmv,
        (select coalesce(sum(cost_usd), 0) from ai_usage where created_at >= ${ts(yesterday)} and created_at < ${ts(today)}) as ai_usd,
        (select count(*) from listings where status = 'pending') as pending,
        (select count(*) from complaints where resolved_at is null) as complaints,
        (select count(*) from orders where status in ('new', 'confirmed', 'courier_assigned', 'picked_up')
           and updated_at < now() - interval '24 hours') as stuck,
        (select count(*) from jobs where done_at is null and attempts >= ${MAX_ATTEMPTS}) as failed_jobs,
        (select count(*) from disputes where status = 'open') as disputes`);
    const month = await this.repo.aiSpendSince(startOfMonthUtc(now));
    const limit = await this.repo.getSetting("ai_monthly_limit_usd", 50);
    const pct = limit ? Math.round((month / limit) * 100) : 0;
    const date = yesterday.toLocaleDateString("ru-RU", { timeZone: "Asia/Tashkent", day: "numeric", month: "long" });
    const misses = await this.searchMisses(yesterday, 5, today);
    const attention = [
      num(y.pending) && `🛡 на модерации: ${num(y.pending)}`,
      num(y.complaints) && `⚠️ открытых жалоб: ${num(y.complaints)}`,
      num(y.stuck) && `⏳ заказов без движения > 24 ч: ${num(y.stuck)}`,
      num(y.disputes) && `⚖️ открытых споров покупателей: ${num(y.disputes)}`,
      pct >= 80 && `💸 AI: ${pct}% месячного лимита`,
      num(y.failed_jobs) && `🧯 фоновых задач с ошибкой: ${num(y.failed_jobs)} (посты в каналы, уведомления)`,
    ].filter(Boolean);
    return [
      `📊 Ishonch за ${date}`,
      `Новых пользователей: ${num(y.new_users)} · проверок: ${num(y.checks)} · объявлений: ${num(y.published)}`,
      `Заказов: ${num(y.orders)} · доставлено: ${num(y.delivered)} (${formatUzs(num(y.gmv))}) · возвратов: ${num(y.returned)}`,
      `AI: $${num(y.ai_usd).toFixed(2)} за день, $${month.toFixed(2)} из $${limit} за месяц (${pct}%)`,
      ...(attention.length ? ["", "Требует внимания:", ...attention] : []),
      // What buyers wanted and did not find: a hint for sellers and shops, or a spelling to teach the search.
      ...(misses.length ? ["", `🔎 Искали, но не нашли: ${misses.map((m) => `«${m.q}» ×${m.count}`).join(", ")}`] : []),
    ].join("\n");
  }
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
