-- Travel-app taste-matching engine — real v1 schema
-- Renamed and rewritten 2026-08-13 (Task 68's audit + fix pass) from the previous
-- schema/supabase_schema.sql, dated 2026-07-24/08-01. That file predated both the
-- retrieval/filter/score architecture pivot and the Neon-over-Supabase decision, and was
-- confirmed as a real, misleading stale artifact (private development log,
-- the private development log Task 68). This is plain, standard PostgreSQL — identical on Neon, no
-- Supabase-specific extensions were ever used, so the rename is branding-only, not a
-- rewrite of the underlying SQL dialect.
--
-- REAL SPLIT, confirmed directly against the current architecture before rewriting:
-- `categories`/`places`/`place_description_signals`/`disqualifier_rules`/`match_results`/
-- `saved_lists`/`saved_list_places` — REMOVED. All of this modeled the OLD, pre-2026-08-07
-- database-driven rules engine (hard-nos and taste signals as queryable rows). That
-- architecture is genuinely gone: category-level taste-fit judgment (hard-nos, positive
-- signals, nuanced rules) now lives entirely in `matching-engine/src/taste-profiles.ts`'s
-- natural-language text, read directly by Gemini in Step 3 — not in a database table at
-- any point. Per-place review/description text is read live via Gemini + Grounding with
-- Google Maps at query time (Step 3), never persisted — so `place_description_signals`
-- has no real role either. A real search result's place identity is Google's own
-- `place_id` (text), never a foreign key into a locally-persisted `places` table — a
-- search result should never require a place to already exist here first.
--
-- `folders`/`searches`/`search_results` — KEPT and adapted, real and well-designed, a
-- genuine head start, not a rebuild. `folders` renamed to `geo_areas` and its `level`
-- check constraint extended to the real, current spec (country → region → city →
-- district — the private development log's "GO LIVE" section), which the original 3-level design
-- (country/city/district, no region) didn't yet cover.
--
-- `api_usage` — ADDED 2026-08-14 (private development log GO LIVE item #2, the real quota-gate
-- build). Genuinely new, not a rename/adaptation of anything in the old file. Real cost
-- fields split into three tracked components rather than one opaque total, because the two
-- real components (Gemini token cost vs. the two real per-SKU free-cap overage surcharges)
-- are billed under genuinely different mechanisms (private development log, 2026-08-12 cost-
-- research entry) — collapsing them into a single number would lose the ability to audit
-- which real lever actually drove a given month's spend. `total_cost_usd` is a generated
-- column (DB-enforced sum of the three), not a fourth independently-set value — the two can
-- never drift out of sync. See `matching-engine/src/quota-gate.ts` for the real logic that
-- computes and writes these.
--
-- IDEMPOTENT AS OF 2026-08-14: every statement below uses `if not exists` — this file is a
-- real, live, growing schema now (geo_areas/searches/search_results already applied
-- 2026-08-14), not a one-shot script. Re-running the whole file (matching-
-- engine/scripts/apply-schema.ts) to add a new table must not fail on tables that already
-- exist in the real database — confirmed necessary the first time `api_usage` was added
-- here, not a defensive guess.
--
-- Schema genuinely live in the real Neon database as of 2026-08-14 (private development log,
-- 2026-08-14 entries) — this is no longer a not-yet-applied starting point.

-- ============================================================================
-- GEO_AREAS
-- Self-referential, one row per Country/Region/City/District node — the real
-- "group by country → city → district, finer granularity where I travel more"
-- hierarchy (private development log, GO LIVE section). Created now purely so
-- `searches.geo_area_id` has somewhere real to eventually point — no CRUD, no
-- UI reads/writes this table until the real folder-UI feature is built.
-- ============================================================================
create table if not exists geo_areas (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  level text not null check (level in ('country', 'region', 'city', 'district')),
  parent_id uuid references geo_areas(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- SEARCHES
-- One row per run search (a specific category + query params). name is
-- nullable — the real current UI doesn't let a user name a search yet, that's
-- part of the folder-UI work, not v1's real scope.
-- ============================================================================
create table if not exists searches (
  id uuid primary key default gen_random_uuid(),
  name text,
  query_params jsonb not null, -- e.g. {"category": "coffee", "anchor": "<neighborhood>, <city>"}
  geo_area_id uuid references geo_areas(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- SEARCH_RESULTS
-- Which real places showed up in a given search, and whether the user has
-- actually opened ("View"-tapped) each one — the only state this app can
-- honestly track (not "saved," just "looked at" — a deep link is
-- one-directional). place_id is Google's own real place ID (text), NOT a
-- foreign key into a locally-persisted places table — a search result
-- shouldn't require that place to be persisted here at all.
-- ============================================================================
create table if not exists search_results (
  id uuid primary key default gen_random_uuid(),
  search_id uuid not null references searches(id) on delete cascade,
  place_id text not null,
  viewed boolean not null default false,
  viewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (search_id, place_id)
);

-- ============================================================================
-- API_USAGE
-- Real quota-gate table (private development log GO LIVE item #2
-- 2026-08-14 entry). One row per real search that actually called Gemini/Places —
-- a denied search (over the internal monthly threshold before any paid call was
-- made) never gets a row here, by design: this table records real incurred cost,
-- not attempted searches. `search_id` is nullable and ON DELETE SET NULL because
-- the real `/api/search` route (private development log item #3) that creates `searches`
-- rows doesn't exist yet — quota-gate.ts can run and record real usage
-- independently of that, matching how Step 1/2/3 themselves were built and
-- validated before any UI/route existed.
--
-- Real cost split, not one opaque total (see file header above for why):
--   gemini_token_cost_usd         — real Gemini input/output/thought token cost
--                                    for this search's calls (Step 1 + Step 3),
--                                    always billed, free-tier-independent.
--   gemini_grounding_surcharge_usd — this search's marginal share of the $14/1000
--                                    Grounding-with-Google-Maps overage, only once
--                                    the real monthly 5,000 free-prompt cap is
--                                    exceeded (private development log 2026-08-12).
--   places_surcharge_usd          — this search's marginal share of the $25/1000
--                                    Places API (New) overage, only once the real
--                                    monthly 1,000 free-request cap is exceeded.
--   geocoding_surcharge_usd       — ADDED 2026-08-19, closing a real, confirmed gap
--                                    (private development log): Google's Geocoding API had
--                                    zero cost tracking here despite being real,
--                                    billed calls since this project's earliest
--                                    live tests. This search's marginal share of
--                                    the real $5.00/1000 Geocoding overage, only
--                                    once the real monthly 10,000 free-request cap
--                                    is exceeded (private development log 2026-08-19,
--                                    live-verified against Google's current pricing
--                                    page, not assumed).
--   total_cost_usd                — generated column, sum of the four above. The
--                                    quota-gate's monthly-threshold check sums this
--                                    column; never independently re-entered.
-- ============================================================================
create table if not exists api_usage (
  id uuid primary key default gen_random_uuid(),
  search_id uuid references searches(id) on delete set null,
  gemini_calls integer not null,
  places_calls integer not null,
  geocoding_calls integer not null default 0,
  gemini_token_cost_usd numeric(10,6) not null,
  gemini_grounding_surcharge_usd numeric(10,6) not null,
  places_surcharge_usd numeric(10,6) not null,
  geocoding_surcharge_usd numeric(10,6) not null default 0,
  total_cost_usd numeric(10,6) generated always as
    (gemini_token_cost_usd + gemini_grounding_surcharge_usd + places_surcharge_usd + geocoding_surcharge_usd) stored,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- REAL MIGRATION, 2026-08-19 — geocoding_calls/geocoding_surcharge_usd for an
-- ALREADY-EXISTING live api_usage table (the CREATE TABLE above only applies to a
-- brand-new database; Postgres's `create table if not exists` silently no-ops on a
-- table that already exists, even with a different column list — it does not add
-- missing columns). Idempotent: `add column if not exists` is safe to re-run
-- directly; the generated-column rebuild is guarded by a real existence check,
-- since Postgres has no `if not exists` form for changing a generated column's
-- own expression — it must be dropped and re-added, and that must only happen
-- once, not on every re-run of this file.
-- ============================================================================
alter table api_usage add column if not exists geocoding_calls integer not null default 0;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'api_usage' and column_name = 'geocoding_surcharge_usd'
  ) then
    alter table api_usage add column geocoding_surcharge_usd numeric(10,6) not null default 0;
    alter table api_usage drop column total_cost_usd;
    alter table api_usage add column total_cost_usd numeric(10,6) generated always as
      (gemini_token_cost_usd + gemini_grounding_surcharge_usd + places_surcharge_usd + geocoding_surcharge_usd) stored;
  end if;
end $$;

-- ============================================================================
-- APP_SETTINGS
-- ADDED 2026-08-14 (quota-gate follow-on build, the private development log same-date
-- entry). Real, small key-value store for mutable app config that needs to survive
-- across serverless invocations — starting with exactly one real key,
-- `monthly_quota_threshold_usd` (the Raise-threshold ladder's current value:
-- $35 default -> $50 -> $65 -> +$15/confirm thereafter). NOT api_usage — that
-- table is an append-only usage LOG, semantically the wrong place for a single
-- mutable current-config value. `value` is `text`, not `numeric`, deliberately —
-- this table is designed to hold whatever future settings show up (not
-- exclusively numeric ones), parsed by the reading code, not the column type.
-- ============================================================================
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- ADMIN_LOGIN_ATTEMPTS
-- ADDED 2026-08-14, same build. Real, durable rate-limiting for the single-admin
-- login POST (private development log, "Quota-gate follow-on" entry: "basic rate
-- limiting on the login attempt itself"). NOT in-memory — Vercel Serverless
-- Functions don't guarantee a shared, persistent process between invocations
-- (cold starts reset any in-memory counter), so a durable, real check requires a
-- real table. One row per real login POST, success or failure; the rate-limit
-- check counts recent failures for a given IP before even checking the password.
-- ============================================================================
create table if not exists admin_login_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text,
  succeeded boolean not null,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- USAGE_RESERVATIONS
-- ADDED 2026-10-20 (spend-protection phase 1). The quota gate used to read only
-- RECORDED spend (api_usage), and a search records its cost at the END, 14-47 s
-- after the check, so N simultaneous requests all passed the same check. A
-- reservation is a row written, under an advisory lock, BEFORE the first paid
-- call: it holds an estimated cost (amount_usd) against the monthly threshold and
-- the daily cap, and counts toward the concurrent-search cap, until it is released
-- (released_at set) when the request finishes, fails or the client disconnects.
-- A reservation older than 10 minutes is treated as released by the gate, so a
-- crashed request cannot lock it. ADDITIVE ONLY: nothing is dropped or altered.
-- ============================================================================
create table if not exists usage_reservations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  amount_usd numeric(10,6) not null,
  released_at timestamptz
);

create index if not exists idx_usage_reservations_open
  on usage_reservations (created_at) where released_at is null;

create index if not exists idx_geo_areas_parent_id on geo_areas(parent_id);
create index if not exists idx_searches_geo_area_id on searches(geo_area_id);
create index if not exists idx_search_results_search_id on search_results(search_id);
create index if not exists idx_api_usage_created_at on api_usage(created_at);
create index if not exists idx_api_usage_search_id on api_usage(search_id);
create index if not exists idx_admin_login_attempts_created_at on admin_login_attempts(created_at);
create index if not exists idx_admin_login_attempts_ip_created_at on admin_login_attempts(ip, created_at);
