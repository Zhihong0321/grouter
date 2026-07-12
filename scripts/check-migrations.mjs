#!/usr/bin/env node
// Migration guard -- blocks the three ways an applied migration breaks a deploy
// under `node-pg-migrate -j sql`, where EVERY .sql file is its own migration
// keyed by filename:
//
//   1. Deleting a migration file that a previous commit already introduced.
//   2. Renaming one (delete + add of the same logical migration).
//   3. Adding a NEW migration whose timestamp is <= a migration that already
//      exists on the main branch (reordering before applied history).
//
// Any of these makes node-pg-migrate's checkOrder throw at deploy time:
//   "Not run migration X is preceding already run migration Y".
//
// This script compares the working tree's migrations/ against the merge-base
// with origin/main and fails loudly BEFORE the bad commit can be pushed.
//
// Run: node scripts/check-migrations.mjs   (also wired into `pnpm prepush`)

import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";

const MIG_DIR = "migrations";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// Baseline = the commit our branch shares with origin/main. Anything already in
// that baseline is treated as "possibly applied in prod" and is immutable.
function baselineRef() {
  const base = sh("git merge-base HEAD origin/main");
  if (base) return base;
  // No remote tracking (fresh clone / detached) -- fall back to HEAD so we at
  // least catch reordering within the working tree.
  return sh("git rev-parse HEAD");
}

function migrationsAtRef(ref) {
  const out = sh(`git ls-tree -r --name-only ${ref} -- ${MIG_DIR}`);
  return out ? out.split("\n").filter((f) => f.endsWith(".sql")).map((f) => f.replace(`${MIG_DIR}/`, "")) : [];
}

function migrationsOnDisk() {
  try {
    return readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql"));
  } catch {
    return [];
  }
}

// node-pg-migrate keys a migration by its filename minus the .sql extension.
function migName(file) {
  return file.replace(/\.sql$/, "");
}

function tsOf(file) {
  const m = file.match(/^(\d+)/);
  return m ? Number(m[1]) : NaN;
}

const base = baselineRef();
const baseFiles = new Set(migrationsAtRef(base));
const diskFiles = new Set(migrationsOnDisk());

const errors = [];

// (1)+(2): every migration present in the baseline must still exist on disk,
// byte-for-byte named the same. A rename shows up here as the old name missing.
for (const f of baseFiles) {
  if (!diskFiles.has(f)) {
    errors.push(
      `Applied migration '${f}' was deleted or renamed. Migrations already on ` +
      `origin/main are immutable -- restore the file exactly. To change schema, ` +
      `add a NEW migration with a newer timestamp instead.`,
    );
  }
}

// (3): a newly-added migration must have a timestamp strictly greater than every
// migration that already existed in the baseline (i.e. it sorts LAST).
const newFiles = [...diskFiles].filter((f) => !baseFiles.has(f));
const maxBaseTs = [...baseFiles].reduce((mx, f) => Math.max(mx, tsOf(f)), 0);
for (const f of newFiles) {
  const ts = tsOf(f);
  if (!Number.isFinite(ts)) {
    errors.push(`New migration '${f}' has no leading numeric timestamp.`);
    continue;
  }
  if (ts <= maxBaseTs) {
    const maxName = [...baseFiles].find((b) => tsOf(b) === maxBaseTs) ?? String(maxBaseTs);
    errors.push(
      `New migration '${f}' (ts ${ts}) is not newer than already-applied '${maxName}' ` +
      `(ts ${maxBaseTs}). Give it a timestamp greater than ${maxBaseTs} so it runs ` +
      `AFTER applied history.`,
    );
  }
}

// Advisory: warn on the split .up.sql/.down.sql format for NEW migrations. It
// isn't broken, but every past incident traces back to it; single-file is safer.
for (const f of newFiles) {
  if (/\.(up|down)\.sql$/.test(f)) {
    console.warn(
      `${YELLOW}warning:${RESET} new migration '${f}' uses the split .up/.down format. ` +
      `Prefer a single '${migName(f).replace(/\.(up|down)$/, "")}.sql' with ` +
      `'-- Up Migration' / '-- Down Migration' markers (see CLAUDE.md).`,
    );
  }
}

if (errors.length > 0) {
  console.error(`${RED}✗ Migration guard failed (${errors.length}):${RESET}`);
  for (const e of errors) console.error(`  ${RED}•${RESET} ${e}`);
  console.error(`\nBaseline compared against: ${base}`);
  process.exit(1);
}

console.log(`${GREEN}✓ Migration guard passed${RESET} (${newFiles.length} new, ${baseFiles.size} immutable, baseline ${base.slice(0, 8)})`);
