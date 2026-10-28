// Real, small key-value settings store — the private development log, 2026-08-14 "Quota-gate
// follow-on" entry. Backs the Raise-threshold admin action: the monthly quota threshold used
// to be a hardcoded constant in quota-gate.ts (`MONTHLY_QUOTA_THRESHOLD_USD = 35`); it's now
// a real, mutable, persisted value, since the product owner needs to be able to raise it from the admin
// page (not in this repo) without a code deploy. `app_settings` (not `api_usage` — that table is an append-only
// usage log, the wrong semantic home for a single current-config value) holds it.
import { clearThresholdAlert, defaultGateDb, gateTable, type GateDb } from "./spend-gate.js";

const THRESHOLD_KEY = "monthly_quota_threshold_usd";

/** Real, locked default/seed value — the private development log GO LIVE item #2 spec, the conservative (low) end of the real $35-38 range. Used only the first time the app ever reads the setting, before any row exists yet. */
export const DEFAULT_MONTHLY_QUOTA_THRESHOLD_USD = 35;

/**
 * Real, locked escalation ladder — the private development log "Quota-gate follow-on" entry:
 * $35 (default) -> confirm -> $50 -> confirm -> $65 -> +$15 per confirmation thereafter.
 * No automatic ceiling — purely the product owner's call, every time, forever.
 */
export function nextThresholdInLadder(current: number): number {
  if (current < 50) return 50;
  if (current < 65) return 65;
  return current + 15;
}

/** Real current threshold, read live from app_settings — seeds the row with the real default if this is the very first read (fresh database, no row yet). */
export async function getMonthlyQuotaThresholdUsd(db: GateDb = defaultGateDb()): Promise<number> {
  const pool = db.pool;
  const settings = gateTable(db, "app_settings");
  const result = await pool.query<{ value: string }>(
    `select value from ${settings} where key = $1`,
    [THRESHOLD_KEY]
  );
  if (result.rows[0]) return Number(result.rows[0].value);

  // First-ever read: seed the row with the real, locked default, not just return the
  // constant unpersisted — every subsequent read/raise operates on a real row from here on.
  await pool.query(
    `insert into ${settings} (key, value) values ($1, $2)
     on conflict (key) do nothing`,
    [THRESHOLD_KEY, String(DEFAULT_MONTHLY_QUOTA_THRESHOLD_USD)]
  );
  return DEFAULT_MONTHLY_QUOTA_THRESHOLD_USD;
}

/** Real Raise-threshold admin action — moves the real current value up the locked ladder and persists it. Returns the new value. No expiry, no auto-revert — usable any time, per the real, locked spec. Also clears the "alert already sent" flag (2026-10-20), so the next crossing of the new threshold sends its own alert. */
export async function raiseMonthlyQuotaThreshold(db: GateDb = defaultGateDb()): Promise<number> {
  const current = await getMonthlyQuotaThresholdUsd(db);
  const next = nextThresholdInLadder(current);
  await db.pool.query(
    `insert into ${gateTable(db, "app_settings")} (key, value, updated_at) values ($1, $2, now())
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [THRESHOLD_KEY, String(next)]
  );
  await clearThresholdAlert(db);
  return next;
}
