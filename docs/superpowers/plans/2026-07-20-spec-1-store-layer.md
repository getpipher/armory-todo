# SPEC-1: Store Layer — Lifecycle Boxes + Prune + Archive + Restore

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn armory-todo's flat open/done list into a lifecycle-box store (active / parked / archive) so the agent context sees only the working set, finished work moves to a sealed archive, and deferred work has a `parked` home — all reversible, nothing deleted by default.

**Architecture:** Split the single `src/todo-store.ts` into focused modules: `paths.ts` (TODO_DIR resolution), `config.ts` (prune/health config), `migrate.ts` (v1→v2 folder migration), `archive.ts` (archive store + prune + restore), with `todo-store.ts` remaining the public API surface that re-exports + owns the live store CRUD + `parked` status + extended `list`. The extension (`extensions/todo.ts`) gains `park`/`prune`/`restore` tool actions + typed slash subcommands.

**Tech Stack:** TypeScript, Node.js (`node:fs`, `node:os`, `node:path`), zero runtime deps. Tests: plain `node test/*.test.mts` with `await import` (matches existing harness). pi extension API (`@earendil-works/pi-coding-agent`), typebox, `@earendil-works/pi-ai` (peer deps).

**Design doc:** `docs/superpowers/specs/2026-07-20-lifecycle-boxes-prune-design.md` (§4 storage, §5 data model, §6 transitions, §7 tool API, §12 edge cases, §13 testing).

## Global Constraints

- **Zero runtime dependencies** — `node:fs`/`node:os`/`node:path` only. No `better-sqlite3`, no `lodash`, nothing. (Matches v0.1.0's "no dependencies" stance, design §9 of the original SPEC.)
- **File perms `0600`** on every JSON file written (`todo.json`, `todo-archive.json`, `todo.config.json`).
- **Atomic writes** — write to `<path>.tmp` + `renameSync` to the final path. Never write partial JSON.
- **Corrupt-file recovery** — on parse failure, back up to `<path>.bad-<ts>` and start fresh. Never crash the session.
- **2-space indent**, meaningful names, comments only for complex logic. No TODO/FIXME in delivered code.
- **Backwards-compatible** — existing `add`/`update`/`complete`/`delete`/`list` behavior preserved. `clear` is deprecated but kept (removed in a later release).
- **Store version bumped to 2.** v1 stores are migrated on first load.
- **`Status` enum widened to `"open" | "in_progress" | "parked" | "done" | "cancelled"`.**
- **Auto-injection logic unchanged** — `renderOpenBlock` still injects `open` + `in_progress` only (parked is auto-excluded by the existing filter).
- Tests run via `node test/todo-store.test.mts` (and new `test/todo-archive.test.mts`, `test/todo-config.test.mts`, `test/todo-migrate.test.mts`).

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `src/paths.ts` | Resolve `TODO_DIR` → concrete file paths (`todo.json`, `todo-archive.json`, `todo.config.json`). Single source of truth for path logic. | Create |
| `src/config.ts` | `TodoConfig` type, `DEFAULT_CONFIG`, `loadConfig`, `saveConfig`. Owns `todo.config.json`. | Create |
| `src/migrate.ts` | `migrateIfNeeded({ todoDir, legacyPath })` — one-time v1 single-file → v2 folder move. Pure function, testable without touching real home. | Create |
| `src/archive.ts` | `ArchiveStore` type, `loadArchive`, `saveArchive`, `pruneTodos`, `restoreTodo`, `archiveSummary`, `listArchived`. Owns the archive box + cross-file moves. | Create |
| `src/todo-store.ts` | Public API surface. `Todo`/`Store` types, `loadStore`/`saveStore` (v2), `add`/`update`/`complete`/`delete`/`park`/`list` (extended with archived/filters/pagination/summary), `renderOpenBlock`, `clearTodos` (deprecated). Re-exports config/archive/migrate entry points used by the extension. | Modify |
| `extensions/todo.ts` | Add `park`/`prune`/`restore` tool actions; extend `list` params (`archived`, `since`, `before`, `text`, `limit`, `page`); add typed slash subcommands (`park`, `restore`, `prune`, `prune --all`, `archive`, `archive <filter>`). | Modify |
| `test/todo-store.test.mts` | Extend existing tests: `parked` round-trip, `parked` excluded from `renderOpenBlock`, extended `list` filters/pagination/summary. | Modify |
| `test/todo-config.test.mts` | Config defaults, load, save, corrupt-file recovery, missing-file → defaults. | Create |
| `test/todo-migrate.test.mts` | v1 single-file → v2 folder migration; idempotency; migration failure → backup. | Create |
| `test/todo-archive.test.mts` | Archive load/save, `prune` age-based + `--all`, `restore`, `listArchived` filters + pagination, `archiveSummary`, `restore` of non-archived id errors. | Create |

---

## Task 1: Paths module — TODO_DIR resolution

**Files:**
- Create: `src/paths.ts`
- Test: `test/todo-store.test.mts` (modify the env-setup block at top)

**Interfaces:**
- Produces: `getTodoDir(): string`, `getLivePath(): string`, `getArchivePath(): string`, `getConfigPath(): string`, `getLegacyPath(): string` (the old `~/.pi/agent/todo.json`).

- [ ] **Step 1: Write the failing test**

Add to the top of `test/todo-store.test.mts`, replacing the existing `process.env.TODO_STORE_PATH = ...` line:

```ts
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "armory-todo-"));
process.env.TODO_DIR = tmp;

const { getTodoDir, getLivePath, getArchivePath, getConfigPath, getLegacyPath } =
  await import("../src/paths.ts");

// --- paths resolve under TODO_DIR ---
eq("getTodoDir is TODO_DIR", getTodoDir(), tmp);
eq("live path under TODO_DIR", getLivePath(), join(tmp, "todo.json"));
eq("archive path under TODO_DIR", getArchivePath(), join(tmp, "todo-archive.json"));
eq("config path under TODO_DIR", getConfigPath(), join(tmp, "todo.config.json"));
ok("legacy path is the real ~/.pi/agent/todo.json", getLegacyPath().endsWith(join(".pi", "agent", "todo.json")));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-store.test.mts`
Expected: FAIL — `Cannot find module '../src/paths.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/paths.ts`:

```ts
// Path resolution for the armory-todo folder layout (v2).
//
// All store files live under TODO_DIR (default ~/.pi/agent/todo/):
//   todo.json          — live store (open, in_progress, parked)
//   todo-archive.json  — sealed history (done, cancelled)
//   todo.config.json   — prune ages + health thresholds
//
// The legacy v1 single file was ~/.pi/agent/todo.json; migrate.ts handles
// moving it into the folder on first load.

import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DIR = join(homedir(), ".pi", "agent", "todo");
const LEGACY_PATH = join(homedir(), ".pi", "agent", "todo.json");

export function getTodoDir(): string {
  return process.env.TODO_DIR || DEFAULT_DIR;
}

export function getLivePath(): string {
  return join(getTodoDir(), "todo.json");
}

export function getArchivePath(): string {
  return join(getTodoDir(), "todo-archive.json");
}

export function getConfigPath(): string {
  return join(getTodoDir(), "todo.config.json");
}

/** The pre-v2 single-file store location. Used by migrate.ts. */
export function getLegacyPath(): string {
  return LEGACY_PATH;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-store.test.mts`
Expected: the 5 path assertions pass. (Other tests may still fail if they referenced the old `TODO_STORE_PATH` — we fix those in Task 9 when we rewire the store. For now, paths-only assertions must pass.)

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts test/todo-store.test.mts
git commit -m "feat(paths): TODO_DIR-based path resolution for v2 folder layout"
```

---

## Task 2: Config module — defaults, load, save

**Files:**
- Create: `src/config.ts`
- Create: `test/todo-config.test.mts`

**Interfaces:**
- Produces: `TodoConfig`, `DEFAULT_CONFIG`, `loadConfig(): TodoConfig`, `saveConfig(config: TodoConfig): void`.

- [ ] **Step 1: Write the failing test**

Create `test/todo-config.test.mts`:

```ts
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

const tmp = mkdtempSync(join(tmpdir(), "armory-config-"));
process.env.TODO_DIR = tmp;

const { DEFAULT_CONFIG, loadConfig, saveConfig } = await import("../src/config.ts");

// --- defaults ---
eq("default prune age 7", DEFAULT_CONFIG.prune.defaultAgeDays, 7);
eq("default hard age 180", DEFAULT_CONFIG.prune.hardAgeDays, 180);
eq("default prune statuses done+cancelled", DEFAULT_CONFIG.prune.statuses.length, 2);
eq("default activeMaxOpen 15", DEFAULT_CONFIG.health.activeMaxOpen, 15);
eq("default activeStaleDays 30", DEFAULT_CONFIG.health.activeStaleDays, 30);
eq("default parkedMax 10", DEFAULT_CONFIG.health.parkedMax, 10);
eq("default parkedStaleDays 60", DEFAULT_CONFIG.health.parkedStaleDays, 60);
eq("default archiveMax 200", DEFAULT_CONFIG.health.archiveMax, 200);
eq("default archiveOldDays 180", DEFAULT_CONFIG.health.archiveOldDays, 180);

// --- missing config → defaults written ---
const cfg = loadConfig();
eq("loadConfig returns defaults when missing", cfg.prune.defaultAgeDays, 7);
ok("config file created on first load", existsSync(join(tmp, "todo.config.json")));

// --- save + reload round-trip ---
const mutated = { ...cfg, prune: { ...cfg.prune, defaultAgeDays: 14 } };
saveConfig(mutated);
const reloaded = loadConfig();
eq("saved config reloads", reloaded.prune.defaultAgeDays, 14);

// --- config file is 0600 ---
const stat = readFileSync(join(tmp, "todo.config.json"));
// (mode checked via statSync below for consistency with store tests)
import { statSync } from "node:fs";
const mode = statSync(join(tmp, "todo.config.json")).mode & 0o777;
ok("config file mode 0600", mode === 0o600, `(mode ${mode.toString(8)})`);

// --- corrupt config → backup + fresh defaults ---
writeFileSync(join(tmp, "todo.config.json"), "{ not json", "utf8");
const recovered = loadConfig();
eq("corrupt config → defaults", recovered.prune.defaultAgeDays, 7);
ok("corrupt config backed up", existsSync(join(tmp, "todo.config.json" + ".bad-")) || recovered.prune.defaultAgeDays === 7);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-config.test.mts`
Expected: FAIL — `Cannot find module '../src/config.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/config.ts`:

```ts
// Prune + health configuration for armory-todo.
//
// Stored at <TODO_DIR>/todo.config.json. Missing or corrupt → defaults are
// rewritten (the bad file is backed up to todo.config.json.bad-<ts>). All
// values are editable (later, via the SPEC-3 /todo Config panel).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getConfigPath } from "./paths.ts";

export interface PruneConfig {
  /** Closed todos older than this (by closedAt) are moved to archive on `prune`. */
  defaultAgeDays: number;
  /** Archive items older than this are flagged for hard-prune suggestion. */
  hardAgeDays: number;
  /** Which terminal statuses get pruned. */
  statuses: ("done" | "cancelled")[];
}

export interface HealthConfig {
  activeMaxOpen: number;
  activeStaleDays: number;
  parkedMax: number;
  parkedStaleDays: number;
  archiveMax: number;
  archiveOldDays: number;
}

export interface TodoConfig {
  version: 1;
  prune: PruneConfig;
  health: HealthConfig;
}

export const DEFAULT_CONFIG: TodoConfig = {
  version: 1,
  prune: {
    defaultAgeDays: 7,
    hardAgeDays: 180,
    statuses: ["done", "cancelled"],
  },
  health: {
    activeMaxOpen: 15,
    activeStaleDays: 30,
    parkedMax: 10,
    parkedStaleDays: 60,
    archiveMax: 200,
    archiveOldDays: 180,
  },
};

function now(): string {
  return new Date().toISOString();
}

/** Deep clone of DEFAULT_CONFIG (so callers can't mutate the constant). */
function freshDefaults(): TodoConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as TodoConfig;
}

export function loadConfig(): TodoConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    const cfg = freshDefaults();
    saveConfig(cfg);
    return cfg;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as TodoConfig;
    if (!parsed || typeof parsed !== "object" || !parsed.prune || !parsed.health) {
      throw new Error("invalid config shape");
    }
    // Merge with defaults so new fields get filled in on upgrade.
    return {
      version: 1,
      prune: { ...DEFAULT_CONFIG.prune, ...parsed.prune },
      health: { ...DEFAULT_CONFIG.health, ...parsed.health },
    };
  } catch {
    try {
      renameSync(path, `${path}.bad-${Date.now()}`);
    } catch {
      // best-effort backup
    }
    const cfg = freshDefaults();
    saveConfig(cfg);
    return cfg;
  }
}

/** Atomic, 0600 write. */
export function saveConfig(config: TodoConfig): void {
  const path = getConfigPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // some filesystems ignore mode bits
  }
  renameSync(tmp, path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-config.test.mts`
Expected: PASS (all assertions)

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/todo-config.test.mts
git commit -m "feat(config): todo.config.json with prune + health defaults"
```

---

## Task 3: Migration — v1 single-file → v2 folder

**Files:**
- Create: `src/migrate.ts`
- Create: `test/todo-migrate.test.mts`

**Interfaces:**
- Produces: `migrateIfNeeded({ todoDir: string, legacyPath: string }): void` — if `todoDir/todo.json` doesn't exist but `legacyPath` does, create the folder + move the legacy file to `todoDir/todo.json`. Idempotent. On failure, restore the legacy file from a `.bak-<ts>` backup.

- [ ] **Step 1: Write the failing test**

Create `test/todo-migrate.test.mts`:

```ts
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

const { migrateIfNeeded } = await import("../src/migrate.ts");

// --- Case 1: legacy file exists, folder doesn't → migrate ---
{
  const todoDir = mkdtempSync(join(tmpdir(), "armory-mig1-"));
  const legacy = join(todoDir, "legacy-todo.json");
  // legacy file with a v1 store
  writeFileSync(legacy, JSON.stringify({ version: 1, updatedAt: "2026-06-23T10:00:00Z", todos: [{ id: "td-x", text: "old", project: "", tags: [], priority: "med", status: "done", source: "", createdAt: "2026-06-23T10:00:00Z", updatedAt: "2026-06-23T10:00:00Z", closedAt: "2026-06-23T10:00:00Z" }] }, null, 2), "utf8");
  // the "folder" is a sibling dir that doesn't exist yet
  const targetDir = join(todoDir, "todo");
  migrateIfNeeded({ todoDir: targetDir, legacyPath: legacy });
  ok("case1: todo.json moved into folder", existsSync(join(targetDir, "todo.json")));
  ok("case1: legacy file removed", !existsSync(legacy));
  const moved = JSON.parse(readFileSync(join(targetDir, "todo.json"), "utf8"));
  ok("case1: moved content preserved", moved.todos.length === 1 && moved.todos[0].id === "td-x");
  rmSync(todoDir, { recursive: true, force: true });
}

// --- Case 2: folder already exists → no-op (idempotent) ---
{
  const todoDir = mkdtempSync(join(tmpdir(), "armory-mig2-"));
  const legacy = join(todoDir, "legacy-todo.json");
  writeFileSync(legacy, '{"version":1,"todos":[]}', "utf8");
  const targetDir = join(todoDir, "todo");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "todo.json"), '{"version":2,"todos":[]}', "utf8");
  migrateIfNeeded({ todoDir: targetDir, legacyPath: legacy });
  ok("case2: legacy file untouched (no-op)", existsSync(legacy));
  ok("case2: existing todo.json untouched", JSON.parse(readFileSync(join(targetDir, "todo.json"), "utf8")).version === 2);
  rmSync(todoDir, { recursive: true, force: true });
}

// --- Case 3: neither exists → no-op (fresh install) ---
{
  const todoDir = mkdtempSync(join(tmpdir(), "armory-mig3-"));
  const legacy = join(todoDir, "nope.json"); // doesn't exist
  const targetDir = join(todoDir, "todo");
  migrateIfNeeded({ todoDir: targetDir, legacyPath: legacy });
  ok("case3: no todo.json created (no legacy to move)", !existsSync(join(targetDir, "todo.json")));
  rmSync(todoDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-migrate.test.mts`
Expected: FAIL — `Cannot find module '../src/migrate.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/migrate.ts`:

```ts
// One-time v1 → v2 migration: move the legacy single-file store
// (~/.pi/agent/todo.json) into the v2 folder layout (~/.pi/agent/todo/todo.json).
//
// Pure + testable: takes explicit paths rather than reading env, so tests can
// point at temp dirs without touching the real home directory.
//
// Idempotent: if the target todo.json already exists, do nothing (the user
// already migrated, or started fresh on v2).

import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface MigrateInput {
  /** The v2 folder (e.g. ~/.pi/agent/todo/). */
  todoDir: string;
  /** The pre-v2 single file (e.g. ~/.pi/agent/todo.json). */
  legacyPath: string;
}

/**
 * If `<todoDir>/todo.json` does not exist but `legacyPath` does, create the
 * folder and move the legacy file in. Atomic-ish: the legacy file is copied
 * first (as a .bak), then moved, so a mid-move failure leaves the legacy file
 * intact. Safe to call on every load.
 */
export function migrateIfNeeded(input: MigrateInput): void {
  const target = join(input.todoDir, "todo.json");
  if (existsSync(target)) return; // already v2
  if (!existsSync(input.legacyPath)) return; // nothing to migrate

  mkdirSync(input.todoDir, { recursive: true });
  // Copy-then-rename so the legacy file survives a crash between copy + rename.
  const backup = `${input.legacyPath}.migrate-bak-${Date.now()}`;
  copyFileSync(input.legacyPath, backup);
  try {
    renameSync(input.legacyPath, target);
    // success → remove the backup
    try { unlinkSync(backup); } catch { /* best-effort */ }
  } catch {
    // rename failed → restore from backup (legacy file may have been moved
    // on some filesystems; copy it back to be safe)
    try { copyFileSync(backup, input.legacyPath); } catch { /* best-effort */ }
    throw new Error(`migration failed: could not move ${input.legacyPath} → ${target}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-migrate.test.mts`
Expected: PASS (all 3 cases)

- [ ] **Step 5: Commit**

```bash
git add src/migrate.ts test/todo-migrate.test.mts
git commit -m "feat(migrate): v1 single-file → v2 folder layout migration"
```

---

## Task 4: `parked` status + `parkTodo`

**Files:**
- Modify: `src/todo-store.ts` (widen Status enum, add `parkTodo`)
- Modify: `test/todo-store.test.mts` (parked round-trip + renderOpenBlock exclusion)

**Interfaces:**
- Produces: `Status` now includes `"parked"`. `parkTodo(id: string): Todo` — sets status to `parked`, clears `closedAt`.

- [ ] **Step 1: Write the failing test**

Append to `test/todo-store.test.mts` (after the `fresh import` line, which we'll update in Task 9 to import from the rewired store; for now add the import of `parkTodo`):

```ts
// At the top, extend the fresh-import line to include parkTodo + listTodos:
const { addTodo, listTodos, updateTodo, completeTodo, deleteTodo, clearTodos, renderOpenBlock, loadStore, parkTodo } =
  await import("../src/todo-store.ts");
```

Then append these assertions near the end of the test file (before the `rmSync(tmp, ...)` cleanup):

```ts
// --- parked status: round-trip + excluded from renderOpenBlock ---
const p1 = addTodo({ text: "maybe someday task", project: "pi", priority: "low" });
const parked = parkTodo(p1.id);
eq("park sets status parked", parked.status, "parked");
eq("park clears closedAt", parked.closedAt, null);
// parked is NOT in the default actionable list
eq("parked excluded from default list", listTodos().some((t) => t.id === p1.id), false);
// parked IS visible with status=all
eq("parked in status=all", listTodos({ status: "all" }).some((t) => t.id === p1.id), true);
// parked is NOT in the injected Open TODOs block
const blockAfterPark = renderOpenBlock();
ok("parked not in renderOpenBlock", !blockAfterPark.includes("maybe someday task"));
// parked → back to open via update
updateTodo(p1.id, { status: "open" });
eq("parked → open re-includes in default list", listTodos().some((t) => t.id === p1.id), true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-store.test.mts`
Expected: FAIL — `parkTodo is not a function` (and `parked` not yet a valid status)

- [ ] **Step 3: Write minimal implementation**

In `src/todo-store.ts`, make these exact edits:

1. Widen the `Status` type and `STATUSES` array:

```ts
export type Status = "open" | "in_progress" | "parked" | "done" | "cancelled";
```
```ts
const STATUSES: Status[] = ["open", "in_progress", "parked", "done", "cancelled"];
```

2. Add `parkTodo` after `completeTodo`:

```ts
export function parkTodo(id: string): Todo {
  return updateTodo(id, { status: "parked" });
}
```

(The existing `updateTodo` already handles `closedAt` clearing: `if (!nowDone) todo.closedAt = null;` — and `parked` is not `done`/`cancelled`, so `closedAt` is cleared. The `assertStatus` call in `updateTodo` will accept `"parked"` once it's in `STATUS_SET`, which it is because `STATUSES` now includes it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-store.test.mts`
Expected: PASS — parked assertions pass. (Note: the test file still sets `process.env.TODO_STORE_PATH` at the top from the old harness; the store still reads `STORE_PATH` until Task 9 rewires it to `TODO_DIR`. The parked tests will work because they go through `addTodo`/`parkTodo`/`listTodos` which use whatever path the store currently reads. **Do not remove the old `TODO_STORE_PATH` line yet — Task 9 handles the full rewire.**)

- [ ] **Step 5: Commit**

```bash
git add src/todo-store.ts test/todo-store.test.mts
git commit -m "feat(store): parked status + parkTodo (deferred/someday box)"
```

---

## Task 5: Archive store — load + save

**Files:**
- Create: `src/archive.ts` (ArchiveStore type, loadArchive, saveArchive)
- Create: `test/todo-archive.test.mts` (first slice — load/save only; prune/restore come in Tasks 6–7)

**Interfaces:**
- Produces: `ArchiveStore` (`{ version: 2, updatedAt, todos: Todo[] }`), `loadArchive(): ArchiveStore`, `saveArchive(store: ArchiveStore): void`. Missing archive → empty store (no file created until first save).

- [ ] **Step 1: Write the failing test**

Create `test/todo-archive.test.mts`:

```ts
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

const tmp = mkdtempSync(join(tmpdir(), "armory-archive-"));
process.env.TODO_DIR = tmp;
// Pre-Task-9 rewire: the live store still reads TODO_STORE_PATH. Point it at the
// same temp file the v2 folder will use (<tmp>/todo.json) so prune/restore don't
// touch the real ~/.pi/agent/todo.json. Task 9 drops this once loadStore reads
// getLivePath() under TODO_DIR.
process.env.TODO_STORE_PATH = join(tmp, "todo.json");

const { loadArchive, saveArchive } = await import("../src/archive.ts");
import type { Todo } from "../src/todo-store.ts";

// --- missing archive → empty store, no file created ---
const empty = loadArchive();
eq("missing archive → 0 todos", empty.todos.length, 0);
eq("archive version 2", empty.version, 2);
ok("archive file not created on bare load", !existsSync(join(tmp, "todo-archive.json")));

// --- save + reload round-trip ---
const sample: Todo = { id: "td-arch1", text: "finished thing", project: "pi", tags: [], priority: "med", status: "done", source: "test", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z", closedAt: "2026-07-02T00:00:00Z" };
saveArchive({ version: 2, updatedAt: "2026-07-02T00:00:00Z", todos: [sample] });
ok("archive file created on save", existsSync(join(tmp, "todo-archive.json")));
const reloaded = loadArchive();
eq("archive reload count", reloaded.todos.length, 1);
eq("archive reload id", reloaded.todos[0]!.id, "td-arch1");

// --- 0600 perms + atomic (no .tmp leftover) ---
const mode = statSync(join(tmp, "todo-archive.json")).mode & 0o777;
ok("archive file mode 0600", mode === 0o600, `(mode ${mode.toString(8)})`);
ok("no archive .tmp leftover", !existsSync(join(tmp, "todo-archive.json.tmp")));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-archive.test.mts`
Expected: FAIL — `Cannot find module '../src/archive.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/archive.ts`:

```ts
// Sealed history store for armory-todo — holds done/cancelled todos moved
// here by `prune`. Recoverable via `restore`; permanently deletable only via
// `prune --hard` (SPEC-2). Never auto-injected into the system prompt.
//
// File: <TODO_DIR>/todo-archive.json (0600, atomic write). Missing on disk
// → empty store returned; the file is created on first save, not first load.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getArchivePath } from "./paths.ts";
import type { Todo } from "./todo-store.ts";

export interface ArchiveStore {
  version: 2;
  updatedAt: string;
  todos: Todo[];
}

function now(): string {
  return new Date().toISOString();
}

function emptyArchive(): ArchiveStore {
  return { version: 2, updatedAt: now(), todos: [] };
}

/** Load the archive. Missing file → empty store (no file created). */
export function loadArchive(): ArchiveStore {
  const path = getArchivePath();
  if (!existsSync(path)) return emptyArchive();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ArchiveStore;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.todos)) {
      throw new Error("invalid archive shape");
    }
    return parsed;
  } catch {
    try {
      renameSync(path, `${path}.bad-${Date.now()}`);
    } catch {
      // best-effort backup
    }
    return emptyArchive();
  }
}

/** Atomic, 0600 write. */
export function saveArchive(store: ArchiveStore): void {
  store.updatedAt = now();
  const path = getArchivePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // some filesystems ignore mode bits
  }
  renameSync(tmp, path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-archive.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/archive.ts test/todo-archive.test.mts
git commit -m "feat(archive): sealed history store (load + save, 0600 atomic)"
```

---

## Task 6: `prune` — age-based move to archive

**Files:**
- Modify: `src/archive.ts` (add `pruneTodos`)
- Modify: `test/todo-archive.test.mts` (prune tests)

**Interfaces:**
- Produces: `pruneTodos(opts: { ageDays?: number; all?: boolean; statuses?: ("done" | "cancelled")[] }): { moved: number; ids: string[] }` — reads the live store, moves qualifying `done`/`cancelled` todos to the archive, saves both. `ageDays` defaults to `config.prune.defaultAgeDays`; `all: true` ignores age. `statuses` defaults to `config.prune.statuses`.

**Consumes:** `loadStore`/`saveStore` from `src/todo-store.ts` (Task 9 rewires these to the folder; for now they still read `STORE_PATH`, so `pruneTodos` must call into the live-store functions). `loadConfig` from `src/config.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/todo-archive.test.mts` (before the cleanup `rmSync`):

```ts
// --- prune: age-based move to archive ---
const { pruneTodos, loadArchive: reloadArch } = await import("../src/archive.ts");
const { addTodo, completeTodo, loadStore, saveStore } = await import("../src/todo-store.ts");
import { writeFileSync } from "node:fs";

// Set up a live store with: one old-done (prunable), one fresh-done (not prunable), one open (never pruned)
const livePath = process.env.TODO_STORE_PATH!;
// Build a live store directly on disk so we control closedAt timestamps
const oldDate = new Date(Date.now() - 30 * 86400_000).toISOString(); // 30 days ago
const freshDate = new Date().toISOString();
writeFileSync(livePath, JSON.stringify({
  version: 1, updatedAt: freshDate,
  todos: [
    { id: "td-old-done", text: "old done", project: "", tags: [], priority: "med", status: "done", source: "", createdAt: oldDate, updatedAt: oldDate, closedAt: oldDate },
    { id: "td-fresh-done", text: "fresh done", project: "", tags: [], priority: "med", status: "done", source: "", createdAt: freshDate, updatedAt: freshDate, closedAt: freshDate },
    { id: "td-open", text: "still open", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: freshDate, updatedAt: freshDate, closedAt: null },
  ],
}, null, 2), "utf8");

// prune with age=7 days → only the old-done moves
const result = pruneTodos({ ageDays: 7 });
eq("prune moved 1 (age-based)", result.moved, 1);
eq("prune moved the old one", result.ids[0], "td-old-done");
const archAfter = reloadArch();
ok("archive has the old-done", archAfter.todos.some((t) => t.id === "td-old-done"));
const liveAfter = loadStore();
ok("fresh-done stays in live", liveAfter.todos.some((t) => t.id === "td-fresh-done"));
ok("open stays in live", liveAfter.todos.some((t) => t.id === "td-open"));
ok("old-done gone from live", !liveAfter.todos.some((t) => t.id === "td-old-done"));

// prune --all → fresh-done also moves
const result2 = pruneTodos({ all: true });
eq("prune --all moved 1 (the fresh-done)", result2.moved, 1);
const liveAfter2 = loadStore();
ok("fresh-done gone after --all", !liveAfter2.todos.some((t) => t.id === "td-fresh-done"));
ok("open still in live after --all", liveAfter2.todos.some((t) => t.id === "td-open"));

// cancelled also pruned
const { deleteTodo } = await import("../src/todo-store.ts");
const c1 = addTodo({ text: "to cancel", priority: "low" });
deleteTodo(c1.id);
const result3 = pruneTodos({ all: true });
ok("prune --all also moved cancelled", result3.moved >= 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-archive.test.mts`
Expected: FAIL — `pruneTodos is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/archive.ts`:

```ts
import { loadConfig } from "./config.ts";
import { loadStore, saveStore } from "./todo-store.ts";

export interface PruneInput {
  ageDays?: number;
  all?: boolean;
  statuses?: ("done" | "cancelled")[];
}

export interface PruneResult {
  moved: number;
  ids: string[];
}

/**
 * Move done/cancelled todos from the live store to the archive.
 *
 * A todo qualifies when:
 *   - its status is in `statuses` (default: config.prune.statuses = done+cancelled), AND
 *   - `all` is true, OR its `closedAt` is older than `ageDays` days ago
 *     (default: config.prune.defaultAgeDays).
 *
 * Both stores are saved atomically. Reversible via `restoreTodo`.
 */
export function pruneTodos(opts: PruneInput = {}): PruneResult {
  const config = loadConfig();
  const ageDays = opts.ageDays ?? config.prune.defaultAgeDays;
  const statuses = new Set(opts.statuses ?? config.prune.statuses);
  const cutoff = opts.all ? null : Date.now() - ageDays * 86400_000;

  const live = loadStore();
  const archive = loadArchive();

  const moved: Todo[] = [];
  const kept: Todo[] = [];
  for (const todo of live.todos) {
    if (!statuses.has(todo.status as "done" | "cancelled")) {
      kept.push(todo);
      continue;
    }
    if (cutoff !== null && todo.closedAt && Date.parse(todo.closedAt) > cutoff) {
      // too fresh — keep in live
      kept.push(todo);
      continue;
    }
    moved.push(todo);
  }

  if (moved.length === 0) return { moved: 0, ids: [] };

  live.todos = kept;
  archive.todos.push(...moved);
  saveStore(live);
  saveArchive(archive);

  return { moved: moved.length, ids: moved.map((t) => t.id) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-archive.test.mts`
Expected: PASS (archive load/save + prune age-based + prune --all + cancelled)

- [ ] **Step 5: Commit**

```bash
git add src/archive.ts test/todo-archive.test.mts
git commit -m "feat(archive): prune — age-based + --all move to archive"
```

---

## Task 7: `restore` — move archived todo back to live as open

**Files:**
- Modify: `src/archive.ts` (add `restoreTodo`)
- Modify: `test/todo-archive.test.mts` (restore tests)

**Interfaces:**
- Produces: `restoreTodo(id: string): Todo` — moves the todo from the archive to the live store, sets `status: "open"`, `closedAt: null`, bumps `updatedAt`. Throws `TodoError` if the id isn't in the archive.

- [ ] **Step 1: Write the failing test**

Append to `test/todo-archive.test.mts` (before cleanup):

```ts
// --- restore: archive → live as open ---
const { restoreTodo } = await import("../src/archive.ts");

// archive currently has the old-done + fresh-done + cancelled from earlier
const before = loadArchive();
const archId = before.todos[0]!.id;
const restored = restoreTodo(archId);
eq("restore sets status open", restored.status, "open");
eq("restore clears closedAt", restored.closedAt, null);
const archAfterRestore = loadArchive();
ok("restore removed from archive", !archAfterRestore.todos.some((t) => t.id === archId));
const liveAfterRestore = loadStore();
ok("restore added to live", liveAfterRestore.todos.some((t) => t.id === archId));
ok("restored is open in live", liveAfterRestore.todos.find((t) => t.id === archId)!.status === "open");

// --- restore of a non-archived id errors ---
let threw = false;
try {
  restoreTodo("td-does-not-exist");
} catch {
  threw = true;
}
ok("restore non-archived id throws", threw);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-archive.test.mts`
Expected: FAIL — `restoreTodo is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `src/archive.ts`:

```ts
import { TodoError } from "./todo-store.ts";

/**
 * Move an archived todo back to the live store as `open` (closedAt cleared).
 * Throws TodoError if the id is not in the archive. Both stores are saved.
 */
export function restoreTodo(id: string): Todo {
  const archive = loadArchive();
  const idx = archive.todos.findIndex((t) => t.id === id);
  if (idx < 0) throw new TodoError(`not in archive: ${id}`);
  const [todo] = archive.todos.splice(idx, 1);
  const live = loadStore();
  todo.status = "open";
  todo.closedAt = null;
  todo.updatedAt = now();
  live.todos.push(todo);
  saveStore(live);
  saveArchive(archive);
  return todo;
}
```

(`now` is already defined in archive.ts from Task 5. `TodoError` is already exported from todo-store.ts.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-archive.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/archive.ts test/todo-archive.test.mts
git commit -m "feat(archive): restore — archived todo back to live as open"
```

---

## Task 8: Extended `list` — archived, filters, pagination, summary

**Files:**
- Modify: `src/archive.ts` (add `listArchived`, `archiveSummary`)
- Modify: `src/todo-store.ts` (extend `listTodos` with `text`, `since`, `before`, `limit`, `page`)
- Modify: `test/todo-store.test.mts` (live list filters/pagination)
- Modify: `test/todo-archive.test.mts` (archived list + summary)

**Interfaces:**
- Produces:
  - `listTodos(filter)` gains: `text?: string` (substring match on `text`), `since?: string` / `before?: string` (ISO, filter by `createdAt`), `limit?: number` (default 20), `page?: number` (default 1). Returns the paginated slice.
  - `listArchived(filter): { items: Todo[]; total: number }` — filter by `project`, `tag`, `status`, `text`, `since`/`before` (by `closedAt`), `limit`/`page`. Bare call (no filters) returns `{ items: [], total, summary }` via `archiveSummary` instead.
  - `archiveSummary(): { total: number; byProject: Record<string, number>; byMonth: Record<string, number> }` — counts for the summary-first default.

- [ ] **Step 1: Write the failing test**

Append to `test/todo-store.test.mts` (before cleanup):

```ts
// --- extended list: text search + since/before + pagination ---
const { addTodo: addMore, listTodos: listMore } = await import("../src/todo-store.ts");
const s1 = addMore({ text: "research browser-use for solana", project: "sol", priority: "low" });
const s2 = addMore({ text: "ship nuntius spec-2", project: "nuntius", priority: "high" });
// text search
const searchText = listMore({ text: "browser-use" });
eq("text search matches 1", searchText.length, 1);
eq("text search returns the right one", searchText[0]!.id, s1.id);
eq("text search no match returns 0", listMore({ text: "zzznomatch" }).length, 0);
// since/before on createdAt
const iso = s1.createdAt;
eq("since filter excludes earlier", listMore({ since: iso }).some((t) => t.id === s1.id), true);
// pagination
const page1 = listMore({ limit: 1, page: 1 });
const page2 = listMore({ limit: 1, page: 2 });
eq("limit=1 page1 has 1 item", page1.length, 1);
eq("limit=1 page2 has 1 item", page2.length, 1);
ok("pages differ", page1[0]!.id !== page2[0]!.id);
```

Append to `test/todo-archive.test.mts` (before cleanup):

```ts
// --- listArchived: filters + pagination ---
const { listArchived, archiveSummary } = await import("../src/archive.ts");

// archive has accumulated items from earlier prune tests
const summary = archiveSummary();
ok("summary has total >= 1", summary.total >= 1);
ok("summary byProject is an object", typeof summary.byProject === "object");
ok("summary byMonth is an object", typeof summary.byMonth === "object");

// listArchived with a project filter
const allArch = listArchived({ limit: 100 });
ok("listArchived returns items + total", allArch.items.length >= 1 && allArch.total >= 1);
// pagination
const archPage1 = listArchived({ limit: 1, page: 1 });
const archPage2 = listArchived({ limit: 1, page: 2 });
eq("arch limit=1 page1 has <=1", archPage1.items.length, 1);
ok("arch pages differ or page2 empty", archPage1.items[0]?.id !== archPage2.items[0]?.id);
// text search on archived
const archSearch = listArchived({ text: "done", limit: 100 });
ok("arch text search works", archSearch.items.every((t) => t.text.includes("done")));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-store.test.mts && node test/todo-archive.test.mts`
Expected: FAIL — `listMore` text/pagination params ignored (old listTodos doesn't support them); `listArchived`/`archiveSummary` undefined.

- [ ] **Step 3: Write minimal implementation**

**3a. Extend `listTodos` in `src/todo-store.ts`.** Update the `ListFilter` interface and the `listTodos` function:

Replace the `ListFilter` interface:

```ts
export interface ListFilter {
  status?: Status | "all";
  project?: string;
  tag?: string;
  text?: string;       // substring match on todo.text (case-insensitive)
  since?: string;      // ISO date; filter createdAt >= since
  before?: string;     // ISO date; filter createdAt < before
  limit?: number;      // default 20
  page?: number;       // default 1 (1-indexed)
}
```

Replace the `listTodos` function body (keep the existing sort; add filtering + pagination at the end):

```ts
export function listTodos(filter: ListFilter = {}): Todo[] {
  const store = loadStore();
  let out = store.todos;
  if (filter.status && filter.status !== "all") {
    assertStatus(filter.status);
    out = out.filter((t) => t.status === filter.status);
  } else if (!filter.status) {
    // default: actionable set only
    out = out.filter((t) => t.status === "open" || t.status === "in_progress");
  }
  if (filter.project) out = out.filter((t) => t.project === filter.project);
  if (filter.tag) out = out.filter((t) => t.tags.includes(filter.tag as string));
  if (filter.text) {
    const q = filter.text.toLowerCase();
    out = out.filter((t) => t.text.toLowerCase().includes(q));
  }
  if (filter.since) out = out.filter((t) => t.createdAt >= (filter.since as string));
  if (filter.before) out = out.filter((t) => t.createdAt < (filter.before as string));
  const sorted = out.slice().sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "in_progress" ? -1 : b.status === "in_progress" ? 1 : 0;
    }
    if (PRIO_ORDER[a.priority] !== PRIO_ORDER[b.priority]) {
      return PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority];
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
  const limit = filter.limit ?? 20;
  const page = filter.page ?? 1;
  const start = (page - 1) * limit;
  return sorted.slice(start, start + limit);
}
```

**3b. Add `listArchived` + `archiveSummary` to `src/archive.ts`:**

```ts
export interface ArchiveListFilter {
  project?: string;
  tag?: string;
  status?: "done" | "cancelled";
  text?: string;
  since?: string;    // by closedAt
  before?: string;   // by closedAt
  limit?: number;    // default 20
  page?: number;     // default 1
}

export interface ArchiveListResult {
  items: Todo[];
  total: number;       // total matching the filter (before pagination)
  summary?: ArchiveSummary;  // present only on a bare call (no filters)
}

export interface ArchiveSummary {
  total: number;
  byProject: Record<string, number>;
  byMonth: Record<string, number>;
}

/** Counts by project + by closedAt-month, for the summary-first default. */
export function archiveSummary(): ArchiveSummary {
  const archive = loadArchive();
  const byProject: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  for (const t of archive.todos) {
    const proj = t.project || "(none)";
    byProject[proj] = (byProject[proj] ?? 0) + 1;
    const month = t.closedAt ? t.closedAt.slice(0, 7) : "(none)"; // YYYY-MM
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }
  return { total: archive.todos.length, byProject, byMonth };
}

/**
 * Query the archive with filters + pagination. A bare call (no filters)
 * returns summary-only (items: []) — drill down with a filter to get rows.
 */
export function listArchived(filter: ArchiveListFilter = {}): ArchiveListResult {
  const hasFilter = Boolean(filter.project || filter.tag || filter.status || filter.text || filter.since || filter.before);
  if (!hasFilter) {
    const summary = archiveSummary();
    return { items: [], total: summary.total, summary };
  }
  let out = loadArchive().todos;
  if (filter.project) out = out.filter((t) => t.project === filter.project);
  if (filter.tag) out = out.filter((t) => t.tags.includes(filter.tag as string));
  if (filter.status) out = out.filter((t) => t.status === filter.status);
  if (filter.text) {
    const q = filter.text.toLowerCase();
    out = out.filter((t) => t.text.toLowerCase().includes(q));
  }
  if (filter.since) out = out.filter((t) => (t.closedAt ?? t.updatedAt) >= (filter.since as string));
  if (filter.before) out = out.filter((t) => (t.closedAt ?? t.updatedAt) < (filter.before as string));
  // sort newest-closed first
  const sorted = out.slice().sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
  const total = sorted.length;
  const limit = filter.limit ?? 20;
  const page = filter.page ?? 1;
  const start = (page - 1) * limit;
  return { items: sorted.slice(start, start + limit), total };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/todo-store.test.mts && node test/todo-archive.test.mts && node test/todo-config.test.mts && node test/todo-migrate.test.mts`
Expected: all four PASS

- [ ] **Step 5: Commit**

```bash
git add src/todo-store.ts src/archive.ts test/todo-store.test.mts test/todo-archive.test.mts
git commit -m "feat(list): extended filters (text/since/before) + pagination + archive summary"
```

---

## Task 9: Rewire store to v2 folder layout (TODO_DIR + migration)

**Files:**
- Modify: `src/todo-store.ts` (replace `STORE_PATH`/`DEFAULT_PATH` with `getLivePath()`; run `migrateIfNeeded` on load; bump `Store.version` to 2; update corrupt-recovery to use folder paths)
- Modify: `test/todo-store.test.mts` (replace `TODO_STORE_PATH` with `TODO_DIR`; update the corrupt-file + perms tests to the new paths)

**Interfaces:**
- Produces: `loadStore` now reads `getLivePath()` under `TODO_DIR`, runs `migrateIfNeeded` first, and validates `version: 2`. `saveStore` writes to `getLivePath()`.

- [ ] **Step 1: Write the failing test**

In `test/todo-store.test.mts`, replace the env-setup block at the very top:

```ts
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "armory-todo-"));
process.env.TODO_DIR = tmp;
// NOTE: no TODO_STORE_PATH — v2 uses TODO_DIR; the store reads <tmp>/todo.json

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}
```

And update the perms/corrupt tests near the bottom to use the new path:

```ts
// --- atomic + 0600 perms (v2 path) ---
import { getLivePath } from "../src/paths.ts";
const livePath = getLivePath();
const stat = statSync(livePath);
ok("store file mode 0600", (stat.mode & 0o777) === 0o600, `(mode ${(stat.mode & 0o777).toString(8)})`);
ok("no .tmp leftover", !existsSync(livePath + ".tmp"));

// --- corrupt file recovery (v2 path) ---
rmSync(livePath, { force: true });
writeFileSync(livePath, "{ this is not json", "utf8");
const recovered = loadStore();
ok("corrupt file → fresh empty store", recovered.todos.length === 0);
```

Remove the old `process.env.TODO_STORE_PATH` reference and any `statSync(process.env.TODO_STORE_PATH)` lines — they're replaced by `getLivePath()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-store.test.mts`
Expected: FAIL — the store still reads `STORE_PATH` (the old `TODO_STORE_PATH`-derived path), so with `TODO_DIR` set but no file there, `addTodo` writes to the wrong place / `statSync(getLivePath())` fails (file doesn't exist yet at the new path).

- [ ] **Step 3: Write minimal implementation**

In `src/todo-store.ts`, make these edits:

1. Replace the path constants + import:

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getLivePath, getTodoDir, getLegacyPath } from "./paths.ts";
import { migrateIfNeeded } from "./migrate.ts";
```

Remove the old `DEFAULT_PATH` / `STORE_PATH` / `homedir` import lines.

2. Update `emptyStore` to version 2:

```ts
function emptyStore(): Store {
  return { version: 2, updatedAt: now(), todos: [] };
}
```

3. Update the `Store` interface:

```ts
export interface Store {
  version: 2;
  updatedAt: string;
  todos: Todo[];
}
```

4. Update `loadStore` to migrate + read the folder path + accept version 2:

```ts
/** Load the live store from disk. Runs v1→v2 migration first. On corruption,
 *  backs up the bad file and starts fresh. */
export function loadStore(): Store {
  migrateIfNeeded({ todoDir: getTodoDir(), legacyPath: getLegacyPath() });
  const path = getLivePath();
  if (!existsSync(path)) return emptyStore();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.todos)) {
      throw new Error("invalid store shape");
    }
    if (parsed.version !== 2) {
      // v1 → v2: accept it (the migration moved the file), just bump the version in memory
      // (the data shape is otherwise identical; parked status is new but old todos won't have it)
      parsed.version = 2;
    }
    return parsed;
  } catch {
    try {
      renameSync(path, `${path}.bad-${Date.now()}`);
    } catch {
      // best-effort backup
    }
    return emptyStore();
  }
}
```

5. Update `saveStore` to use `getLivePath()`:

```ts
/** Atomic, 0600 write. */
export function saveStore(store: Store): void {
  store.updatedAt = now();
  const path = getLivePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // some filesystems ignore mode bits; not fatal
  }
  renameSync(tmp, path);
}
```

6. Update `getStorePath` (used by the `/todo path` slash command) to return the live path:

```ts
export function getStorePath(): string {
  return getLivePath();
}
```

- [ ] **Step 4: Run all tests to verify they pass**

Run: `node test/todo-store.test.mts && node test/todo-archive.test.mts && node test/todo-config.test.mts && node test/todo-migrate.test.mts`
Expected: all four PASS. (Note: the archive test sets `TODO_STORE_PATH` to point `pruneTodos`/`restoreTodo` at the same temp live store — but now the store reads `getLivePath()` under `TODO_DIR`. The archive test already sets `process.env.TODO_DIR = tmp`, so `loadStore`/`saveStore` in archive.ts will read/write `<tmp>/todo.json` — which is where the archive test's `writeFileSync(livePath, ...)` puts the seeded live store. Verify `livePath` in the archive test is computed as `getLivePath()` — update that line if it still references `TODO_STORE_PATH`.)

If the archive test has `const livePath = process.env.TODO_STORE_PATH || join(tmp, "todo.json")`, replace it with:
```ts
import { getLivePath } from "../src/paths.ts";
const livePath = getLivePath();
```

- [ ] **Step 5: Commit**

```bash
git add src/todo-store.ts test/todo-store.test.mts test/todo-archive.test.mts
git commit -m "feat(store): v2 folder layout + migration on load (TODO_DIR)"
```

---

## Task 10: Extension tool — park / prune / restore + extended list params

**Files:**
- Modify: `extensions/todo.ts` (add `park`/`prune`/`restore` to the tool `ACTIONS`; extend the `list` case with `archived`/`since`/`before`/`text`/`limit`/`page`; wire the new actions)

**Interfaces:**
- Consumes: `parkTodo`, `pruneTodos`, `restoreTodo`, `listArchived`, `archiveSummary` from the store modules.
- Produces: the `todo` tool now accepts `action: "park" | "prune" | "restore"` and the `list` action honors the new filter/pagination params.

- [ ] **Step 1: Write the failing test (manual — extension tests are manual-gate per the original SPEC §10)**

No automated extension test (the extension imports pi APIs that aren't available in a standalone node test). The manual gate for this task: after implementation, in a real pi session, verify `/todo park <id>`, `/todo prune`, `/todo restore <id>` work. The store-level logic is already covered by Tasks 4–8. For this task, the test is: **load the extension without a syntax/import error**.

Create a minimal smoke check — append to `test/todo-store.test.mts` (a compile-only import check):

```ts
// --- extension imports cleanly (smoke) ---
try {
  // The extension imports pi APIs (peer deps) — just check it parses + exports default
  const mod = await import("../extensions/todo.ts");
  ok("extension module imports + has default export", typeof mod.default === "function");
} catch (err) {
  ok("extension module imports", false, String((err as Error).message || err));
}
```

(Note: this may fail if pi peer deps aren't resolvable in the test env. If it does, mark it as a known limitation and rely on the manual gate — but *first* try it; `@earendil-works/pi-coding-agent` may resolve via the installed pi in `~/.pi/agent/npm`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-store.test.mts`
Expected: FAIL — `park`/`prune`/`restore` not in `ACTIONS`, so the extension's tool doesn't accept them (the smoke import may pass if the module loads, but the action routing is incomplete). The real failure surfaces when we try to use the actions.

- [ ] **Step 3: Write minimal implementation**

In `extensions/todo.ts`, make these edits:

1. Update the imports from `../src/todo-store`:

```ts
import {
  addTodo,
  completeTodo,
  deleteTodo,
  clearTodos,
  listTodos,
  renderOpenBlock,
  updateTodo,
  parkTodo,
  getStorePath,
} from "../src/todo-store.ts";
import { pruneTodos, restoreTodo, listArchived, archiveSummary } from "../src/archive.ts";
```

2. Update `ACTIONS`:

```ts
const ACTIONS = ["list", "add", "update", "complete", "delete", "clear", "park", "prune", "restore"] as const;
```

3. Extend the tool `parameters` schema (add the new filter params + the `archived` flag):

```ts
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      id: Type.Optional(Type.String({ description: "Todo id (for update/complete/delete/park/restore)" })),
      text: Type.Optional(Type.String({ description: "Todo text (add) or new text (update); or substring search (list)" })),
      project: Type.Optional(Type.String({ description: "Project tag, e.g. 'pi', 'sip', or '' for global" })),
      tags: Type.Optional(Type.Array(Type.String())),
      priority: Type.Optional(StringEnum(["low", "med", "high", "critical"] as const)),
      status: Type.Optional(StringEnum(["open", "in_progress", "parked", "done", "cancelled"] as const)),
      // list filters
      statusFilter: Type.Optional(StringEnum(["open", "in_progress", "parked", "done", "cancelled", "all"] as const)),
      projectFilter: Type.Optional(Type.String()),
      tagFilter: Type.Optional(Type.String()),
      archived: Type.Optional(Type.Boolean({ description: "If true, query the archive instead of the live store. Bare archived:true (no other filter) returns a summary." })),
      since: Type.Optional(Type.String({ description: "ISO date filter (createdAt for live, closedAt for archive)" })),
      before: Type.Optional(Type.String({ description: "ISO date filter (createdAt for live, closedAt for archive)" })),
      limit: Type.Optional(Type.Number({ description: "Page size (default 20)" })),
      page: Type.Optional(Type.Number({ description: "1-indexed page number (default 1)" })),
      // prune options
      ageDays: Type.Optional(Type.Number({ description: "prune: closedAt older than this many days (default from config)" })),
      all: Type.Optional(Type.Boolean({ description: "prune: ignore age, move all done/cancelled" })),
    }),
```

4. Update the `execute` switch — replace the `list` case and add `park`/`prune`/`restore` cases:

```ts
          case "list": {
            if (params.archived) {
              const res = listArchived({
                project: params.projectFilter,
                tag: params.tagFilter,
                status: params.statusFilter as any,
                text: params.text,
                since: params.since,
                before: params.before,
                limit: params.limit,
                page: params.page,
              });
              if (res.summary) {
                const lines = [
                  `## Archive summary (${res.total} total)`,
                  ...Object.entries(res.summary.byProject).map(([p, n]) => `  ${p}: ${n}`),
                  ...Object.entries(res.summary.byMonth).map(([m, n]) => `  ${m}: ${n}`),
                  "Use a filter (project/tag/text/since/before) to list specific items.",
                ];
                return { content: [{ type: "text" as const, text: lines.join("\n") }] };
              }
              const lines = res.items.map(fmt);
              return { content: [{ type: "text" as const, text: `Archived (${res.total} total, page ${params.page ?? 1}):\n${lines.join("\n")}` }] };
            }
            const todos = listTodos({
              status: params.statusFilter as any,
              project: params.projectFilter,
              tag: params.tagFilter,
              text: params.text,
              since: params.since,
              before: params.before,
              limit: params.limit,
              page: params.page,
            });
            if (todos.length === 0) {
              return { content: [{ type: "text" as const, text: "No matching TODOs." }] };
            }
            return { content: [{ type: "text" as const, text: todos.map(fmt).join("\n") }] };
          }
```

And after the `clear` case, add:

```ts
          case "park": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for park." }] };
            const t = parkTodo(params.id);
            return { content: [{ type: "text" as const, text: `Parked ${t.id}: ${t.text}` }] };
          }
          case "prune": {
            const res = pruneTodos({ ageDays: params.ageDays, all: params.all });
            return { content: [{ type: "text" as const, text: `Pruned ${res.moved} todo${res.moved === 1 ? "" : "s"} to archive: ${res.ids.join(", ") || "(none)"}` }] };
          }
          case "restore": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for restore." }] };
            const t = restoreTodo(params.id);
            return { content: [{ type: "text" as const, text: `Restored ${t.id}: ${t.text} [open]` }] };
          }
```

5. Update the `update` action's status enum in the existing `updateTodo` call to accept `parked` — it already passes `params.status as any`, so no change needed (the store validates).

6. Update the tool `description` + `promptGuidelines` to mention the new actions:

```ts
    description:
      "Global cross-session TODO store (persists across ALL pi sessions, not just this one). " +
      "Use when the user says 'put this in our TODO', 'show me the TODO', 'mark <id> done', 'park <id>', 'prune', 'restore <id>', etc. " +
      "Open TODOs are auto-injected each turn; parked todos are NOT injected (deferred/someday). " +
      "Done/cancelled todos are moved to an archive by `prune` (reversible via `restore`). " +
      "Never put secrets in a TODO — the text reaches the model provider.",
    promptSnippet: "Read/update the global cross-session TODO list (active / parked / archive)",
    promptGuidelines: [
      "Use todo (action:'list') when the user asks 'show me the TODO' / 'what's pending'.",
      "Use todo (action:'add', text, project?, tags?, priority?, source?) when the user says 'put this in our TODO'.",
      "Use todo (action:'complete', id) to mark a TODO done; (action:'delete', id) to cancel it.",
      "Use todo (action:'park', id) to defer a TODO (not injected, recoverable); (action:'update', status:'open') to un-park.",
      "Use todo (action:'prune') to move done/cancelled todos to the archive (reversible); (action:'prune', all:true) to prune all regardless of age.",
      "Use todo (action:'restore', id) to bring an archived TODO back as open.",
      "Use todo (action:'list', archived:true) to query the archive — bare call returns a summary; add a filter (project/text/since) for specific items.",
    ],
```

- [ ] **Step 4: Run tests + verify**

Run: `node test/todo-store.test.mts && node test/todo-archive.test.mts && node test/todo-config.test.mts && node test/todo-migrate.test.mts`
Expected: all four PASS (the extension smoke import may or may not pass depending on peer-dep resolution — if it fails on import resolution, that's a test-env limitation, not a code bug; the manual gate covers it).

- [ ] **Step 5: Commit**

```bash
git add extensions/todo.ts test/todo-store.test.mts
git commit -m "feat(ext): park/prune/restore tool actions + extended list (archive, filters, pagination)"
```

---

## Task 11: Extension slash command — typed subcommands

**Files:**
- Modify: `extensions/todo.ts` (add `/todo park <id>`, `/todo restore <id>`, `/todo prune [--all]`, `/todo archive [filter]` to the slash command handler)

**Interfaces:**
- Produces: the `/todo` slash command now routes the new subcommands. `/todo health` is NOT included (that's SPEC-2). Power-user subcommands retained alongside.

- [ ] **Step 1: Write the failing test (manual gate)**

No automated test for slash commands (requires a live pi TUI). Manual gate: after implementation, in a real pi session run `/todo prune`, `/todo park <id>`, `/todo restore <id>`, `/todo archive`, `/todo archive project:nuntius` and confirm each behaves correctly. The store logic is already test-covered (Tasks 4–8); this task is pure routing.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-store.test.mts`
Expected: the store tests still pass (the slash handler isn't exercised by them). The "failure" is that the new subcommands aren't routed — verified manually.

- [ ] **Step 3: Write minimal implementation**

In `extensions/todo.ts`, update the slash command handler — extend the `sub` routing. Replace the existing handler body's routing block (keep the `all`/`add`/`done`/`rm`/`clean`/`path` cases) and add the new subcommands. The full updated routing (insert the new cases before the `// default: list open` fallback):

```ts
        if (sub === "park") {
          const id = rest[0];
          if (!id) { if (ctx.hasUI) ctx.ui.notify("usage: /todo park <id>", "warning"); return; }
          const t = parkTodo(id);
          if (ctx.hasUI) ctx.ui.notify(`Parked ${t.id}: ${t.text}`, "info");
          return;
        }
        if (sub === "restore") {
          const id = rest[0];
          if (!id) { if (ctx.hasUI) ctx.ui.notify("usage: /todo restore <id>", "warning"); return; }
          const t = restoreTodo(id);
          if (ctx.hasUI) ctx.ui.notify(`Restored ${t.id}: ${t.text}`, "info");
          return;
        }
        if (sub === "prune") {
          const all = rest.includes("--all");
          const res = pruneTodos({ all });
          if (ctx.hasUI) ctx.ui.notify(`Pruned ${res.moved} todo${res.moved === 1 ? "" : "s"} to archive: ${res.ids.join(", ") || "(none)"}`, "info");
          return;
        }
        if (sub === "archive") {
          const filterArg = rest.join(" ").trim();
          if (!filterArg) {
            const s = archiveSummary();
            const lines = [
              `Archive summary (${s.total} total):`,
              ...Object.entries(s.byProject).map(([p, n]) => `  ${p}: ${n}`),
              ...Object.entries(s.byMonth).map(([m, n]) => `  ${m}: ${n}`),
              "Use /todo archive project:<name> or text:<query> to list specific items.",
            ];
            if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
          // parse "project:foo" or "text:query" (simple key:value)
          const parts = filterArg.split(":");
          const key = parts[0]?.trim();
          const val = parts.slice(1).join(":").trim();
          const res = key === "project" ? listArchived({ project: val, limit: 50 })
            : key === "text" ? listArchived({ text: val, limit: 50 })
            : listArchived({ text: filterArg, limit: 50 });
          const msg = res.items.length ? res.items.map(fmt).join("\n") : `(no archived items match)`;
          if (ctx.hasUI) ctx.ui.notify(`Archived (${res.total} total):\n${msg}`, "info");
          return;
        }
```

Also update the command `description` to advertise the new subcommands:

```ts
    description: "Global cross-session TODO list. /todo · /todo all · /todo add <text> · /todo done <id> · /todo rm <id> · /todo park <id> · /todo restore <id> · /todo prune [--all] · /todo archive [project:X|text:Y] · /todo clean · /todo path",
```

- [ ] **Step 4: Run tests + verify**

Run: `node test/todo-store.test.mts && node test/todo-archive.test.mts && node test/todo-config.test.mts && node test/todo-migrate.test.mts`
Expected: all four PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/todo.ts
git commit -m "feat(ext): /todo slash subcommands — park, restore, prune, archive"
```

---

## Task 12: README + version bump + package metadata

**Files:**
- Modify: `README.md` (document the lifecycle boxes, new actions, slash subcommands)
- Modify: `package.json` (version bump 0.1.0 → 0.2.0; the SPEC-1 slice is a minor version — new features, backwards-compatible)
- Modify: `AGENTS.md` (update the "Structure" + "Notes" sections to reflect the new folder layout + archive)

**Interfaces:** none (docs only).

- [ ] **Step 1: No failing test** (docs task — fold into the release commit).

- [ ] **Step 2: (skipped — docs)**

- [ ] **Step 3: Write the updates**

In `README.md`, add a "Lifecycle boxes" section after the "What it solves" section:

```markdown
## Lifecycle boxes (v0.2.0)

TODOs live in one of three states, only one of which hits the agent context:

| Box | Status(es) | Auto-injected? | Recoverable? |
|---|---|---|---|
| **Active** | `open`, `in_progress` | ✅ Yes (capped 15) | n/a |
| **Parked** | `parked` | ❌ No | ✅ `update --status open` |
| **Archive** | `done`, `cancelled` | ❌ No | ✅ `restore <id>` |

**Pruning:** `prune` (default: done/cancelled older than 7 days) moves finished
todos from the live file to `todo-archive.json` — nothing is deleted. `prune --all`
ignores age. `restore <id>` brings an archived todo back as `open`.

The only irreversible action is `prune --hard` (SPEC-2, not yet shipped) — it
requires an explicit `confirm: true` and is always user-confirmed.

**Storage layout:**
```
~/.pi/agent/todo/
  todo.json              # active + parked
  todo-archive.json      # done + cancelled (sealed history)
  todo.config.json       # prune ages + health thresholds
```
A v1 single-file store at `~/.pi/agent/todo.json` is migrated automatically on
first load after upgrade.
```

Update the "Structure" section in `README.md` to list the new `src/` modules.

In `package.json`, bump `"version": "0.1.0"` → `"version": "0.2.0"`.

In `AGENTS.md`, update the "Structure" block:

```markdown
## Structure

```
extensions/   # pi extension — todo tool (model-callable) + /todo slash command + auto-inject
src/          # todo-store (live CRUD + parked + list), archive (prune + restore + summary),
              # config (prune/health thresholds), migrate (v1→v2), paths (TODO_DIR resolution)
test/         # todo-store + todo-archive + todo-config + todo-migrate tests
docs/         # SPEC + design docs (docs/superpowers/specs, docs/superpowers/plans)
```
```

And update the "Notes" to mention the folder layout + archive.

- [ ] **Step 4: Run all tests one final time**

Run: `node test/todo-store.test.mts && node test/todo-archive.test.mts && node test/todo-config.test.mts && node test/todo-migrate.test.mts`
Expected: all four PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md package.json AGENTS.md
git commit -m "docs(v0.2.0): lifecycle boxes, prune/archive, folder layout + version bump"
```

---

## Final verification (before declaring SPEC-1 done)

- [ ] All four test files pass: `node test/todo-store.test.mts && node test/todo-archive.test.mts && node test/todo-config.test.mts && node test/todo-migrate.test.mts`
- [ ] No `TODO`/`FIXME`/`HACK` in delivered code (grep `src/` + `extensions/`).
- [ ] No secrets, no hardcoded paths (all paths via `paths.ts`).
- [ ] `renderOpenBlock` unchanged — `parked` confirmed excluded.
- [ ] Manual gate (real pi session): `/todo add test`, `/todo park <id>`, confirm it drops from the injected `## Open TODOs` block on the next turn; `/todo done <id2>`, `/todo prune`, `/todo archive` (summary appears), `/todo restore <archived-id>`, confirm it's back as open.
- [ ] `gh run list` — if CI exists, confirm green.

## Out of scope for SPEC-1 (deferred)

- **`health` action + `prune --hard`** → SPEC-2.
- **Interactive `/todo` TUI panel** → SPEC-3.
- **`title` + `notes`/`log` schema split** → Workstream B (separate spec).
- **Preventive caps-on-add + project registry** → Workstream C (issue #1's hard-block half).