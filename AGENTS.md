# Project instructions

## MIGRATION LAW — read before touching `migrations/` (non-negotiable)

Deploys run `node-pg-migrate -j sql up` on Railway. **In `-j sql` mode every
`.sql` file is its own migration, keyed by its filename.** node-pg-migrate
records each applied migration's name in a `pgmigrations` table and, at every
deploy, verifies the on-disk list still lines up with what already ran. If it
doesn't, `checkOrder` throws *before running anything* and the deploy dies:

> Not run migration X is preceding already run migration Y

Almost every past deploy break came from violating one of these. Do not repeat them.

1. **NEVER delete, rename, or move a migration file that is already on
   `origin/main`.** It is applied in prod and therefore immutable. This includes
   "cleanup", "dedupe", or "reformat" — all forbidden. To change schema, add a
   **new** migration.

2. **NEVER edit the SQL of an applied migration.** Its effect already happened in
   prod; editing it changes nothing there and only causes drift. Add a new one.

3. **New migration = ONE single file**, `<timestamp>_<name>.sql`, containing:
   ```sql
   -- Up Migration
   <forward SQL>

   -- Down Migration
   <reverse SQL>
   ```
   Do **not** create split `.up.sql` / `.down.sql` pairs — in `-j sql` mode those
   register as two separate migrations and are the origin of this whole mess.
   (Old split pairs already in the repo must stay exactly as-is per rule 1.)

4. **Timestamp must be strictly newer** than every migration already on
   `origin/main`, so the new one sorts LAST and runs after applied history. Use a
   millisecond epoch larger than the current max (check `ls migrations/ | sort`).

5. **Make every migration idempotent and additive** so a re-run or slight drift
   can't fail the deploy: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   `DROP ... IF EXISTS`. Prefer adding columns over recreating tables.

6. **Never test migrations locally** (see the no-local-testing rule). Rely on the
   guard below + review, and let Railway apply them on deploy.

### The guard (mechanical enforcement)

`scripts/check-migrations.mjs` compares `migrations/` against the merge-base with
`origin/main` and fails on any delete/rename/reorder of an applied migration.

- Runs automatically on **pre-push** via `.githooks/pre-push`.
- Enable the hook once per clone: `pnpm run hooks:install`
  (sets `git config core.hooksPath .githooks`).
- Run manually anytime: `pnpm run check:migrations`.

If the guard fails, **do not** work around it by deleting files — fix the change
so it obeys the law above.
