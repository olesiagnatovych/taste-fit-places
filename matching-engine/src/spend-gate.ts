// Spend gate, phase 1 (2026-10-20): bounds spend per month, per day and per moment, whoever calls.
//
// The older gate (quota-gate.ts checkQuota) reads only RECORDED spend, and a search records its cost
// at the END, 14-47 s after the check, so N simultaneous requests all passed the same check. This
// module adds RESERVATIONS: before the first paid call, in one transaction under an advisory lock, a
// request is admitted only if
//   month-to-date recorded spend + unreleased reservations + this reservation   < monthly threshold
//   today's recorded spend       + unreleased reservations + this reservation   < daily cap
//   (searches only) unreleased reservations                                     < max concurrent searches
// and, if admitted, a usage_reservations row is written in the same transaction. The row is released
// when the request ends (success, failure or client disconnect). A reservation older than
// RESERVATION_STALE_MINUTES counts as released, so a crashed request cannot lock the gate.
//
// Boundaries (2026-10-20): both the month and the day follow America/Los_Angeles, so they agree with
// each other and with Google's billing month (Pacific time). Before this date the month boundary was
// date_trunc('month', now()), which follows the database session TimeZone (GMT on the live database),
// so the month reset at 00:00 UTC while the day reset at Los Angeles midnight. quota-gate.ts now uses
// monthStartSql() too, so the old gate and this one use the same month.
// Every function takes a GateDb so tests can point the whole gate at a temporary schema.
import type { Pool, PoolClient } from "pg";
import { getPool } from "./db.js";
import type { QuotaAlertDetails } from "./alerts.js";

export interface GateDb {
  pool: Pool;
  /** Optional schema name for tests; live code leaves it unset and uses the default schema. */
  schema?: string;
  /** Advisory-lock key; tests use their own so they never contend with live traffic. */
  lockKey?: number;
}

export const SETTING_KEYS = {
  monthlyThreshold: "monthly_quota_threshold_usd",
  dailyCap: "daily_cap_usd",
  maxConcurrentSearches: "max_concurrent_searches",
  searchReservation: "search_reservation_usd",
  alertSentForThreshold: "alert_sent_for_threshold",
} as const;

export const GATE_DEFAULTS = {
  monthlyThresholdUsd: 35,
  dailyCapUsd: 3.0,
  maxConcurrentSearches: 4,
  searchReservationUsd: 0.15,
} as const;

/** Reservation held by a reverse-geocode request (one geocoding call). */
export const GEOCODE_RESERVATION_USD = 0.01;
export const RESERVATION_STALE_MINUTES = 10;
export const DEFAULT_LOCK_KEY = 7203514001;
export const GATE_TIME_ZONE = "America/Los_Angeles";

export function defaultGateDb(): GateDb {
  return { pool: getPool() };
}

/** Table name, schema-qualified only when a test schema is set. */
export function gateTable(db: GateDb, name: string): string {
  if (!db.schema) return name;
  if (!/^[a-z0-9_]+$/.test(db.schema)) throw new Error("spend-gate: invalid schema name");
  return `"${db.schema}".${name}`;
}

/** SQL for the start of the current Los Angeles month (a timestamptz). `ref` is the reference instant; tests pass a fixed one, live code uses now(). */
export function monthStartSql(ref = "now()"): string {
  return `(date_trunc('month', ${ref} at time zone '${GATE_TIME_ZONE}') at time zone '${GATE_TIME_ZONE}')`;
}
/** SQL for the start of the current Los Angeles day (a timestamptz). */
export function dayStartSql(ref = "now()"): string {
  return `(date_trunc('day', ${ref} at time zone '${GATE_TIME_ZONE}') at time zone '${GATE_TIME_ZONE}')`;
}
const MONTH_START_SQL = monthStartSql();
const DAY_START_SQL = dayStartSql();
const micros = (usd: number) => Math.round(usd * 1_000_000);

export interface GateSettings {
  monthlyThresholdUsd: number;
  dailyCapUsd: number;
  maxConcurrentSearches: number;
  searchReservationUsd: number;
}

type Queryable = Pick<Pool | PoolClient, "query">;

async function readSettingsWith(q: Queryable, db: GateDb): Promise<GateSettings> {
  const keys = [SETTING_KEYS.monthlyThreshold, SETTING_KEYS.dailyCap, SETTING_KEYS.maxConcurrentSearches, SETTING_KEYS.searchReservation];
  const result = await q.query<{ key: string; value: string }>(`select key, value from ${gateTable(db, "app_settings")} where key = any($1)`, [keys]);
  const byKey = new Map(result.rows.map((r) => [r.key, r.value]));
  const num = (key: string, fallback: number) => {
    const n = Number(byKey.get(key));
    return byKey.has(key) && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    monthlyThresholdUsd: num(SETTING_KEYS.monthlyThreshold, GATE_DEFAULTS.monthlyThresholdUsd),
    dailyCapUsd: num(SETTING_KEYS.dailyCap, GATE_DEFAULTS.dailyCapUsd),
    maxConcurrentSearches: Math.floor(num(SETTING_KEYS.maxConcurrentSearches, GATE_DEFAULTS.maxConcurrentSearches)),
    searchReservationUsd: num(SETTING_KEYS.searchReservation, GATE_DEFAULTS.searchReservationUsd),
  };
}

/** Current gate settings, with the documented defaults for any key not yet set. Read-only (used by the admin page). */
export async function getGateSettings(db: GateDb = defaultGateDb()): Promise<GateSettings> {
  return readSettingsWith(db.pool, db);
}

export async function getMonthToDateSpendUsd(db: GateDb = defaultGateDb()): Promise<number> {
  const r = await db.pool.query<{ v: string }>(`select coalesce(sum(total_cost_usd), 0)::text as v from ${gateTable(db, "api_usage")} where created_at >= ${MONTH_START_SQL}`);
  return Number(r.rows[0].v);
}

export async function getTodaySpendUsd(db: GateDb = defaultGateDb()): Promise<number> {
  const r = await db.pool.query<{ v: string }>(`select coalesce(sum(total_cost_usd), 0)::text as v from ${gateTable(db, "api_usage")} where created_at >= ${DAY_START_SQL}`);
  return Number(r.rows[0].v);
}

export interface OpenReservations {
  amountUsd: number;
  count: number;
}

/** Unreleased reservations younger than the stale limit. */
export async function getOpenReservations(db: GateDb = defaultGateDb()): Promise<OpenReservations> {
  const r = await db.pool.query<{ amt: string; n: number }>(
    `select coalesce(sum(amount_usd), 0)::text as amt, count(*)::int as n from ${gateTable(db, "usage_reservations")}
     where released_at is null and created_at > now() - interval '${RESERVATION_STALE_MINUTES} minutes'`
  );
  return { amountUsd: Number(r.rows[0].amt), count: r.rows[0].n };
}

export type ReserveKind = "search" | "geocode";

export type ReserveResult =
  | { admitted: true; reservationId: string; amountUsd: number }
  | { admitted: false; reason: "monthly_threshold" | "daily_cap" | "concurrency" };

/**
 * Atomically decides whether to admit one request and, if so, writes its reservation. Throws on any
 * database error; callers must treat a throw as "deny" (fail closed), same as the older gate.
 * `search` reservations use the search_reservation_usd setting and are subject to the concurrency cap;
 * `geocode` reservations are GEOCODE_RESERVATION_USD and are not (they still count toward the cap's
 * total while open, since the cap counts every unreleased reservation).
 */
export async function reserveSpend(kind: ReserveKind, db: GateDb = defaultGateDb()): Promise<ReserveResult> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [db.lockKey ?? DEFAULT_LOCK_KEY]);

    const settings = await readSettingsWith(client, db);
    const amountUsd = kind === "search" ? settings.searchReservationUsd : GEOCODE_RESERVATION_USD;

    const month = await client.query<{ v: string }>(`select coalesce(sum(total_cost_usd), 0)::text as v from ${gateTable(db, "api_usage")} where created_at >= ${MONTH_START_SQL}`);
    const day = await client.query<{ v: string }>(`select coalesce(sum(total_cost_usd), 0)::text as v from ${gateTable(db, "api_usage")} where created_at >= ${DAY_START_SQL}`);
    const open = await client.query<{ amt: string; n: number }>(
      `select coalesce(sum(amount_usd), 0)::text as amt, count(*)::int as n from ${gateTable(db, "usage_reservations")}
       where released_at is null and created_at > now() - interval '${RESERVATION_STALE_MINUTES} minutes'`
    );

    const reserved = micros(Number(open.rows[0].amt));
    const mine = micros(amountUsd);
    let reason: "monthly_threshold" | "daily_cap" | "concurrency" | null = null;
    if (micros(Number(month.rows[0].v)) + reserved + mine >= micros(settings.monthlyThresholdUsd)) reason = "monthly_threshold";
    else if (micros(Number(day.rows[0].v)) + reserved + mine >= micros(settings.dailyCapUsd)) reason = "daily_cap";
    else if (kind === "search" && open.rows[0].n >= settings.maxConcurrentSearches) reason = "concurrency";

    if (reason) {
      await client.query("rollback");
      return { admitted: false, reason };
    }
    const inserted = await client.query<{ id: string }>(`insert into ${gateTable(db, "usage_reservations")} (amount_usd) values ($1) returning id`, [amountUsd]);
    await client.query("commit");
    return { admitted: true, reservationId: inserted.rows[0].id, amountUsd };
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // connection already unusable; the original error is the one that matters
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Releases a reservation. Safe to call more than once. */
export async function releaseReservation(reservationId: string, db: GateDb = defaultGateDb()): Promise<void> {
  await db.pool.query(`update ${gateTable(db, "usage_reservations")} set released_at = now() where id = $1 and released_at is null`, [reservationId]);
}

// ===== threshold alert: sent once per threshold value =====

/**
 * Atomically claims the right to send the alert for this threshold value: a single upsert that only
 * changes the row when the stored value differs. True only for the one caller whose statement changed
 * the row. Because the flag stores the threshold it was sent for, raising the threshold makes the next
 * crossing claimable again; raiseMonthlyQuotaThreshold() also clears it explicitly.
 */
export async function claimThresholdAlert(thresholdUsd: number, db: GateDb = defaultGateDb()): Promise<boolean> {
  const r = await db.pool.query(
    `insert into ${gateTable(db, "app_settings")} as s (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()
     where s.value is distinct from excluded.value
     returning s.key`,
    [SETTING_KEYS.alertSentForThreshold, String(thresholdUsd)]
  );
  return r.rowCount === 1;
}

export async function clearThresholdAlert(db: GateDb = defaultGateDb()): Promise<void> {
  await db.pool.query(`delete from ${gateTable(db, "app_settings")} where key = $1`, [SETTING_KEYS.alertSentForThreshold]);
}

export type AlertOutcome = "not_crossed" | "already_sent" | "sent";

/**
 * After a request's usage is recorded: if month-to-date spend has reached the threshold, try to claim
 * the alert; only the claimant sends. If sending fails, the claim is cleared (so a later request can
 * retry) and the error is rethrown for the caller's fail-closed handling.
 */
export async function sendThresholdAlertOnce(args: {
  sendEmail: (details: QuotaAlertDetails) => Promise<void>;
  searchCountThisMonth: number;
  db?: GateDb;
}): Promise<AlertOutcome> {
  const db = args.db ?? defaultGateDb();
  const [spend, settings] = await Promise.all([getMonthToDateSpendUsd(db), getGateSettings(db)]);
  if (micros(spend) < micros(settings.monthlyThresholdUsd)) return "not_crossed";
  if (!(await claimThresholdAlert(settings.monthlyThresholdUsd, db))) return "already_sent";
  try {
    await args.sendEmail({ currentMonthSpendUsd: spend, thresholdUsd: settings.monthlyThresholdUsd, searchCountThisMonth: args.searchCountThisMonth });
  } catch (err) {
    await clearThresholdAlert(db);
    throw err;
  }
  return "sent";
}
