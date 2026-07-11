# GRouter Supplier Activity Sync — Build Plan

No code or database changes are part of this planning document.

## Fixed scope

The feature must:

- Copy all SubRouter supplier activity logs into the GRouter PostgreSQL database.
- Sync all historical records, not only recent activity.
- Preserve exact supplier token counts and wallet charges.
- Keep syncing new activity automatically.
- Store supplier data separately without modifying existing GRouter accounting.

The feature must not:

- Modify `reseller_usage_logs`.
- Modify `reseller_request_logs`.
- Modify `reseller_api_keys.spent_cents`.
- Modify customer budgets, prices, routing, or proxy behavior.
- Attempt to connect supplier records to local requests.
- Add dashboards, analytics, margin calculations, alerts, or reporting features.
- Use Playwright as the production sync mechanism.

## Confirmed SubRouter contract

Authentication requires both:

```http
Cookie: session=<secret>
New-Api-User: <supplier-user-id>
```

Endpoints:

```text
GET /api/log/self/
GET /api/log/self/stat
GET /api/user/self
```

Activity pagination parameters:

```text
p
page_size
type=0
token_name
model_name
start_timestamp
end_timestamp
group
request_id
```

Important activity fields:

```text
id
created_at
type
content
token_name
model_name
quota
prompt_tokens
completion_tokens
use_time
is_stream
channel
channel_name
token_id
group
request_id
other
```

Supplier wallet conversion:

```text
500,000 quota units = USD 1
wallet_cost_usd = quota / 500000
```

All monetary calculations must use PostgreSQL `numeric`, never JavaScript floating-point arithmetic.

## Phase 1 — Configuration

- [ ] Add Railway secret `SUBROUTER_SESSION`.
- [ ] Add Railway secret `SUBROUTER_USER_ID`.
- [ ] Add `SUBROUTER_QUOTA_PER_USD=500000`.
- [ ] Add `SUBROUTER_SYNC_ENABLED=true`.
- [ ] Add `SUBROUTER_SYNC_INTERVAL_SECONDS=300`.
- [ ] Never commit the Hermes storage-state file.
- [ ] Never print the session cookie or user ID in application logs.
- [ ] Redact `Cookie` and `New-Api-User` from errors.

The current session comes from:

```text
E:\hermes-agent\auth_states\subrouter_ai.json
```

Railway cannot access that local path. The required values must be placed in Railway secrets during deployment.

## Phase 2 — Supplier activity table

Create a new migration containing a table such as:

```text
reseller_supplier_activity
```

Required columns:

```text
id                       bigserial primary key
supplier                 text not null
external_log_id          bigint not null
external_request_id      text
external_created_at      timestamptz not null
log_type                 integer not null
content                  text
token_name               text
model_name               text
prompt_tokens            bigint not null default 0
completion_tokens        bigint not null default 0
cache_tokens             bigint not null default 0
quota_units              numeric not null
quota_per_usd            numeric not null
wallet_cost_usd          numeric not null
use_time_seconds         numeric
is_stream                boolean
channel_id               bigint
channel_name             text
external_token_id        bigint
supplier_group           text
provider_name            text
billing_source           text
raw_other                jsonb
raw_record               jsonb not null
supplier_updated_at      timestamptz
first_synced_at          timestamptz not null default now()
last_synced_at           timestamptz not null default now()
```

Constraints and indexes:

- [ ] Unique constraint on `(supplier, external_log_id)`.
- [ ] Index on `external_created_at DESC`.
- [ ] Index on `external_request_id`.
- [ ] Index on `model_name`.
- [ ] Index on `token_name`.
- [ ] Index on `(supplier, external_created_at DESC)`.

`wallet_cost_usd` must be calculated as:

```sql
quota_units / quota_per_usd
```

Store both raw quota and converted USD. Never discard the raw supplier value.

## Phase 3 — Supplier account state

Create:

```text
reseller_supplier_account_state
```

This table contains the latest authoritative supplier wallet state:

```text
supplier
remaining_quota_units
used_quota_units
remaining_wallet_usd
used_wallet_usd
request_count
quota_per_usd
supplier_user_id
last_fetched_at
raw_account_state jsonb
```

- [ ] Use one row per supplier.
- [ ] Update it from `/api/user/self` during every sync.
- [ ] Replace the current state atomically.
- [ ] Preserve raw quota values.
- [ ] Do not use local-storage wallet values because they can be stale.

## Phase 4 — Sync cursor table

Create:

```text
reseller_supplier_sync_state
```

Required columns:

```text
supplier
initial_backfill_complete
last_external_log_id
last_external_created_at
last_sync_cutoff
last_attempt_at
last_success_at
last_error
last_error_type
last_imported_count
total_imported_count
updated_at
```

- [ ] Use one row per supplier.
- [ ] Lock the row during a sync.
- [ ] Advance the cursor only after the entire run succeeds.
- [ ] Do not advance it after partial failure.
- [ ] Never delete previously synchronized activity.

## Phase 5 — SubRouter API client

Create a dedicated client module.

- [ ] Use Node `fetch`, not Playwright.
- [ ] Set the session cookie.
- [ ] Set `New-Api-User`.
- [ ] Set `Accept: application/json`.
- [ ] Apply a request timeout.
- [ ] Validate HTTP status.
- [ ] Validate SubRouter’s `{ success, message, data }` envelope.
- [ ] Validate activity records before inserting them.
- [ ] Retain unknown fields in `raw_record`.
- [ ] Retain the complete parsed `other` object in `raw_other`.
- [ ] Treat redirect-to-login, 401, 403, or unsuccessful authentication messages as `auth_expired`.
- [ ] Do not retry authentication failures continuously.

## Phase 6 — Complete historical backfill

The first run must import everything.

- [ ] Set a fixed `sync_cutoff` timestamp at the beginning.
- [ ] Request `type=0`.
- [ ] Use `start_timestamp=0`.
- [ ] Use `end_timestamp=sync_cutoff`.
- [ ] Start at page 1.
- [ ] Continue until every page has been retrieved.
- [ ] Do not stop based only on the first duplicate.
- [ ] Upsert every supplier record using `external_log_id`.
- [ ] Perform bounded batch inserts.
- [ ] Update existing rows if the supplier returns changed data.
- [ ] Mark `initial_backfill_complete=true` only after the final page succeeds.
- [ ] Save the highest `(created_at, id)` as the cursor.
- [ ] Fetch `/api/user/self` after importing the logs.
- [ ] Reconcile against `/api/log/self/stat`.

The backfill must be restartable. If it fails, rerunning it must not duplicate records.

## Phase 7 — Incremental synchronization

After backfill:

- [ ] Capture a fixed `sync_cutoff`.
- [ ] Request records between the previous successful cutoff and the new cutoff.
- [ ] Include a small overlap before the previous cutoff.
- [ ] Paginate through the entire overlapping range.
- [ ] Upsert by supplier log ID.
- [ ] Update changed records.
- [ ] Refresh `/api/user/self`.
- [ ] Call `/api/log/self/stat`.
- [ ] Commit the new cursor only after all operations succeed.

Recommended overlap:

```text
Previous cutoff minus 24 hours
```

The overlap is safe because upserts are idempotent.

## Phase 8 — Exact reconciliation

After each sync, use `/api/log/self/stat` for the synchronized range.

Compare:

```text
Supplier stat quota
Database SUM(quota_units)

Supplier stat token count
Database token totals
```

- [ ] Use the identical start/end timestamps for API and database totals.
- [ ] Require exact quota equality.
- [ ] Record the result in sync state.
- [ ] If totals differ, automatically rescan that complete range.
- [ ] Do not alter existing GRouter usage records to make totals match.
- [ ] Do not mark the run successful while quota reconciliation fails.

After initial backfill, also perform a full-history reconciliation:

```text
start_timestamp=0
end_timestamp=backfill cutoff
```

## Phase 9 — Scheduler and concurrency

- [ ] Run the incremental sync every five minutes.
- [ ] Use a PostgreSQL advisory lock to prevent concurrent runs.
- [ ] Exit cleanly when another worker owns the lock.
- [ ] Do not run overlapping syncs.
- [ ] Allow only one initial backfill at a time.
- [ ] Start scheduling only when `SUBROUTER_SYNC_ENABLED=true`.
- [ ] Keep supplier synchronization outside the proxy request path.
- [ ] Supplier API failure must never interrupt customer proxy traffic.

A Railway cron worker or separate worker process is preferred. If implemented inside the existing Fastify service, the advisory lock is mandatory.

## Phase 10 — Authentication expiry behavior

The SubRouter session is temporary.

- [ ] On expiry, keep all existing synchronized data.
- [ ] Preserve the last successful cursor.
- [ ] Set sync status to `auth_expired`.
- [ ] Stop aggressive retries.
- [ ] Resume from the saved cursor after Railway secrets are updated.
- [ ] Backfill the entire missed interval automatically.
- [ ] Reconcile the missed interval before marking recovery successful.

No automated browser login is included in this scope.

## Phase 11 — Minimal operational endpoint

Add only the endpoint needed to confirm synchronization:

```text
GET /admin/api/supplier-sync/status
```

Return:

```text
supplier
initialBackfillComplete
lastAttemptAt
lastSuccessAt
lastExternalLogId
lastExternalCreatedAt
lastImportedCount
totalImportedCount
reconciliationMatched
lastErrorType
lastError
```

- [ ] Protect it with the existing admin session.
- [ ] Never return supplier credentials.
- [ ] Do not add activity analysis endpoints or dashboard pages.

## Phase 12 — Tests

- [ ] Session cookie and `New-Api-User` are both sent.
- [ ] Secrets are redacted from errors.
- [ ] All historical pages are fetched.
- [ ] Fixed cutoff prevents moving-page errors.
- [ ] Repeated syncs do not duplicate rows.
- [ ] Updated supplier rows update local copies.
- [ ] Quota conversion produces exact decimal USD.
- [ ] Large token and quota values do not overflow.
- [ ] Invalid activity records abort cursor advancement.
- [ ] Partial page failure preserves the old cursor.
- [ ] Authentication expiry preserves synchronized data.
- [ ] Resuming after expiry imports the entire gap.
- [ ] Concurrent workers cannot synchronize simultaneously.
- [ ] Reconciliation detects missing records.
- [ ] Automatic rescan repairs a mismatched range.
- [ ] Existing usage, request-log, budget, and pricing tables remain untouched.

## Completion criteria

The feature is complete only when:

- [ ] Every available historical SubRouter activity record exists in the new table.
- [ ] Supplier log IDs are unique locally.
- [ ] Database total `quota_units` exactly matches SubRouter statistics for the same range.
- [ ] Database wallet cost equals `quota_units / 500000`.
- [ ] Current wallet state matches `/api/user/self`.
- [ ] New activity synchronizes automatically.
- [ ] A repeated full sync produces no duplicates.
- [ ] An expired session can be replaced and the missing interval is recovered.
- [ ] No existing GRouter accounting values are modified.
- [ ] No analytics or unrelated features are included.
