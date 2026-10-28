// Showcase note: this module backs the admin login, which is not in this repo (the admin
// surface was left out). It is kept because the schema and the spend-protection design refer to it.
// Real, basic rate limiting for the single-admin login POST (private development log,
// "Quota-gate follow-on" entry: "basic rate limiting on the login attempt itself"). Deliberately
// NOT in-memory — Vercel Serverless Functions don't guarantee a shared, persistent process
// between invocations (a cold start resets any in-memory counter, and concurrent invocations
// on different instances wouldn't share one anyway), so an in-memory limiter would be
// silently unreliable in the real deployment target. `admin_login_attempts` (schema.sql) is
// the real, durable store.
import { getPool } from "./db.js";

/** Real, locked window/limit — a judgment call, logged as one: 5 failed attempts in 15 minutes. Generous enough that the owner mistyping their own password twice never locks her out; tight enough that brute-forcing a real password (even a strong one) inside a 15-minute window is not realistically viable. */
export const RATE_LIMIT_WINDOW_MINUTES = 15;
export const RATE_LIMIT_MAX_FAILURES = 5;

export interface RateLimitCheck {
  limited: boolean;
  recentFailures: number;
}

/** Checked BEFORE the password is even compared — a caller who's already over the limit never reaches verifyPassword(), real or not. */
export async function checkRateLimit(ip: string | null): Promise<RateLimitCheck> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    `select count(*) as count from admin_login_attempts
     where ip is not distinct from $1
       and succeeded = false
       and created_at >= now() - interval '${RATE_LIMIT_WINDOW_MINUTES} minutes'`,
    [ip]
  );
  const recentFailures = Number(result.rows[0]?.count ?? 0);
  return { limited: recentFailures >= RATE_LIMIT_MAX_FAILURES, recentFailures };
}

/** Records one real login attempt, success or failure — called after every real attempt, regardless of outcome, so the rate-limit window has real data to count against. */
export async function recordLoginAttempt(ip: string | null, succeeded: boolean): Promise<void> {
  const pool = getPool();
  await pool.query(`insert into admin_login_attempts (ip, succeeded) values ($1, $2)`, [ip, succeeded]);
}
