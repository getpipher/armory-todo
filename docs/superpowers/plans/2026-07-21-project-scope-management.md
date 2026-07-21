# Project-Scope Management Implementation Plan (v0.4.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship armory-todo v0.4.0 (Workstream C / Feature A) — a project registry, a `projects` overview, per-project `health` flags, and interactive project rename/merge + `maxOpen` editing in the `/todo` panel. Advisory-only; no enforcement (that's v0.5.0).

**Architecture:** New sibling `projects.json` registry file (own schema v1, lazy-synced on read, no store/config migration). Two new pure modules (`src/registry.ts`, `src/projects.ts`) extend the existing `src/` family. `src/health.ts` gains 4 per-project flags + one new config field (`perProjectDefaultMax=8`, forward-compatible merge, no `TodoConfig` version bump). `extensions/todo.ts` adds two tool actions (`projects`, `project_rename`), one thin slash (`/todo projects`), and a 6th panel tab (`projects`). `src/panel.ts` gains a `Projects` tab with an action submenu (Rename / Set maxOpen / Filter active to project) using the existing inline-`Input` idiom. `src/todo-store.ts` is unchanged (no registry writes on add/update — lazy sync).

**Tech Stack:** TypeScript (raw `.ts`, run via tsx — no build step), `node:fs` only (zero runtime deps), `node:test`-style ad-hoc test harness (`ok`/`eq` + `mkdtempSync`/`TODO_DIR`, matching the 9 existing suites), `@earendil-works/pi-tui` (panel), `typebox` + `@earendil-works/pi-ai` (tool schema).

## Global Constraints

- **Branch:** `feat/project-scope-management` off `main` (already created; spec committed at `8a59baa`).
- **No runtime deps** — `node:fs`/`node:path`/`node:os` only. 2-space indent. No TODO/FIXME. No AI attribution.
- **Atomic 0600 writes** — every new file write uses the tmp+rename+chmod pattern (see `saveConfig`/`saveArchive`).
- **Test idiom** — match `test/todo-config.test.mts`: `mkdtempSync` + `process.env.TODO_DIR = tmp`, `ok`/`eq` helpers, dynamic `await import("../src/…")`, `rmSync` cleanup, `console.log(\`${passed} passed, ${failed} failed\`)`, `process.exit(1)` on fail. Each suite is standalone (run via `node test/<name>.test.mts`).
- **No store migration** — `Store.version: 3` and `TodoConfig.version: 1` stay unchanged. `addTodo`/`updateTodo` are unchanged (no registry writes).
- **Injection unchanged** — `renderOpenBlock` is NOT modified in v0.4.0.
- **Commits** — one per task, `feat(scope): …`. PR → `--merge --delete-branch`. RECTOR QA gate → tag `v0.4.0` → CI auto-publishes npm + GitHub Release.
- **Spec** — `docs/superpowers/specs/2026-07-21-project-scope-management-design.md` (committed). This plan is the execution breakdown of that spec.
- **Carried gotchas** — `ctx.ui.notify(msg, "error")` already prefixes `Error:` (pass bare message). Panel mode flags: set the entering flag `true` AND clear others (`renderShell` branch order: editMode → actionMode → detailMode → config → projects → list). `SelectList` has no public items setter — replace the instance. `git tag` needs `-am` in non-TTY. Edit-tool flakiness on template literals → Python `str.replace` fallback.

---

## File Structure

**Create:**
- `src/registry.ts` — `ProjectRegistry` load/save/reconcile/setMaxOpen/rename. Pure, pi-independent.
- `src/levenshtein.ts` — tiny edit-distance helper (used by `projects.ts` + `health.ts` for typo nearest-sibling).
- `src/projects.ts` — `projectsOverview()` pure read (reconciles registry first).
- `test/registry.test.mts` — registry suite.
- `test/projects.test.mts` — overview suite.

**Modify:**
- `src/paths.ts` — add `getRegistryPath()`.
- `src/config.ts` — add `HealthConfig.perProjectDefaultMax` (default 8) + `DEFAULT_CONFIG` + merge assertion.
- `src/health.ts` — 4 new flags + `ProjectHealth[]` + `noProject` + actionable suggestions; reconcile-first.
- `src/panel-data.ts` — `projectOverviewToItems`, `actionsForProject`, `noProjectSummaryItem`.
- `src/panel.ts` — `Box` gains `projects` (6 tabs); `refreshList` + `onItemSelect` + `openActionSubmenu` + `executeAction` + `renderShell` branch for the projects box; inline `Input` for Rename + Set maxOpen.
- `extensions/todo.ts` — `ACTIONS` gains `projects` + `project_rename`; tool `execute` switch + parameter schema (`oldName`, `newName`); `/todo projects` slash subcommand; health text output gains `projects:` section.
- `test/todo-config.test.mts` — assert `perProjectDefaultMax` default + merge.
- `test/todo-health.test.mts` — 4 per-project flags + `projects[]` + `noProject`.
- `test/panel-data.test.mts` — project-row + action-submenu helpers.
- `README.md` — v0.4.0 section + Known issues (no enforcement until v0.5.0).
- `AGENTS.md` (repo) — v0.4.0 row in the version table.
- `package.json` — version `0.4.0` (final task, before tag).

---

## Task 1: `src/levenshtein.ts` + `src/registry.ts` + registry tests

**Files:**
- Create: `src/levenshtein.ts`
- Create: `src/registry.ts`
- Create: `test/registry.test.mts`

**Interfaces:**
- Produces: `levenshtein(a: string, b: string): number` (≤ 2 used for typo sibling).
- Produces: `ProjectEntry`, `ProjectRegistry`, `getRegistryPath()`, `loadRegistry()`, `saveRegistry(reg)`, `reconcileRegistry(reg, liveTodos, archivedTodos)`, `getProjectEntry(reg, name)`, `setProjectMaxOpen(reg, name, max)`, `renameProject(oldName, newName)`.
- Consumes: `getTodoDir()` from `src/paths.ts` (Task 2 adds `getRegistryPath`, but Task 1 can use `join(getTodoDir(), "projects.json")` directly — keep `getRegistryPath` in `paths.ts` for Task 2 to centralize).

> **Note:** To keep Task 1 self-contained, `src/registry.ts` imports `getTodoDir` from `./paths.ts` and computes the path inline via `join(getTodoDir(), "projects.json")`. Task 2 extracts `getRegistryPath()` into `paths.ts` and swaps the inline call — a tiny refactor that keeps each task independently testable.

- [ ] **Step 1: Write `src/levenshtein.ts`**

```ts
// Tiny Levenshtein edit-distance helper for project-typo nearest-sibling
// detection. Kept dependency-free and allocation-light (two rolling rows).

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}
```

- [ ] **Step 2: Write `src/registry.ts`**

```ts
// Project registry for armory-todo — a sibling file to todo.json holding the
// canonical list of known projects + their per-project advisory cap slot
// (`maxOpen`). Advisory in v0.4.0 (drives a health flag); enforcement
// (block-on-add) graduates in v0.5.0.
//
// File: <TODO_DIR>/projects.json (0600, atomic write). Lazy-synced on read:
// `reconcileRegistry` appends any unknown project strings (live + archived)
// with maxOpen:null. `loadRegistry` is side-effect-free (missing → empty,
// no file created); seeding happens on the first reconcile call.
// No env guard — projects.json always lives under TODO_DIR (temp dir in tests).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getTodoDir } from "./paths.ts";
import { loadStore, saveStore, TodoError, type Todo } from "./todo-store.ts";
import { loadArchive, saveArchive } from "./archive.ts";

export interface ProjectEntry {
  name: string;
  maxOpen: number | null;  // null = no advisory cap for this project
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRegistry {
  version: 1;
  updatedAt: string;
  projects: ProjectEntry[];
}

function now(): string { return new Date().toISOString(); }

function emptyRegistry(): ProjectRegistry {
  return { version: 1, updatedAt: now(), projects: [] };
}

export function getRegistryPath(): string {
  return join(getTodoDir(), "projects.json");
}

export function loadRegistry(): ProjectRegistry {
  const path = getRegistryPath();
  if (!existsSync(path)) return emptyRegistry();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ProjectRegistry;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.projects)) {
      throw new Error("invalid registry shape");
    }
    if (parsed.version !== 1) throw new Error("invalid registry shape");
    return parsed;
  } catch {
    try {
      renameSync(path, `${path}.bad-${Date.now()}`);
    } catch {
      // best-effort backup
    }
    return emptyRegistry();
  }
}

export function saveRegistry(reg: ProjectRegistry): void {
  reg.updatedAt = now();
  const path = getRegistryPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* fs may ignore mode bits */ }
  renameSync(tmp, path);
}

/**
 * Lazy sync: append any unknown non-empty project strings (from live + archived
 * todos) as new entries with maxOpen:null. Returns { reg, changed }. Caller
 * persists iff changed. Idempotent (a second call with no new names → changed=false).
 */
export function reconcileRegistry(
  reg: ProjectRegistry,
  liveTodos: Todo[],
  archivedTodos: Todo[],
): { reg: ProjectRegistry; changed: boolean } {
  const known = new Set(reg.projects.map((p) => p.name));
  const names = new Set<string>();
  for (const t of liveTodos) { const p = t.project.trim(); if (p) names.add(p); }
  for (const t of archivedTodos) { const p = t.project.trim(); if (p) names.add(p); }
  let changed = false;
  for (const name of names) {
    if (!known.has(name)) {
      reg.projects.push({ name, maxOpen: null, createdAt: now(), updatedAt: now() });
      changed = true;
    }
  }
  if (changed) reg.updatedAt = now();
  return { reg, changed };
}

export function getProjectEntry(reg: ProjectRegistry, name: string): ProjectEntry | undefined {
  return reg.projects.find((p) => p.name === name);
}

/**
 * Set a project's maxOpen slot. `max = null` clears. Creates the entry if the
 * name is unknown (with createdAt/updatedAt = now). Throws if name is "" (the
 * (no project) group can't be capped). Mutates `reg` in place + returns the entry.
 */
export function setProjectMaxOpen(reg: ProjectRegistry, name: string, max: number | null): ProjectEntry {
  const trimmed = name.trim();
  if (!trimmed) throw new TodoError("cannot set maxOpen on the (no project) group");
  if (max !== null && (!Number.isFinite(max) || max < 0)) {
    throw new TodoError(`maxOpen must be a non-negative number or null (got ${String(max)})`);
  }
  let entry = getProjectEntry(reg, trimmed);
  if (!entry) {
    entry = { name: trimmed, maxOpen: null, createdAt: now(), updatedAt: now() };
    reg.projects.push(entry);
  }
  entry.maxOpen = max;
  entry.updatedAt = now();
  reg.updatedAt = now();
  return entry;
}

export interface RenameResult {
  liveRenamed: number;
  archivedRenamed: number;
  merged: boolean;
  newName: string;
}

/**
 * Rename (or merge) a project: rewrite every live + archived todo whose
 * `project === oldName` to `newName`, remove the `oldName` registry entry,
 * and ensure the `newName` entry exists. Best-effort multi-file (no WAL):
 * live → archive → registry, each saved atomically with backup-on-corrupt.
 * Throws if `oldName` is not in the registry. Self-rename is a no-op success.
 */
export function renameProject(oldName: string, newName: string): RenameResult {
  const old = oldName.trim();
  const next = newName.trim();
  if (!old) throw new TodoError("oldName is required");
  if (!next) throw new TodoError("newName is required");
  if (old === next) return { liveRenamed: 0, archivedRenamed: 0, merged: false, newName: next };

  const reg = loadRegistry();
  const oldEntry = getProjectEntry(reg, old);
  if (!oldEntry) throw new TodoError(`no project named '${old}' in the registry`);
  const merged = getProjectEntry(reg, next) !== undefined;

  // 1. live store
  const live = loadStore();
  let liveRenamed = 0;
  for (const t of live.todos) {
    if (t.project === old) { t.project = next; t.updatedAt = now(); liveRenamed++; }
  }
  if (liveRenamed > 0) saveStore(live);

  // 2. archive
  const archive = loadArchive();
  let archivedRenamed = 0;
  for (const t of archive.todos) {
    if (t.project === old) { t.project = next; archivedRenamed++; }
  }
  if (archivedRenamed > 0) saveArchive(archive);

  // 3. registry: remove old, ensure next exists
  reg.projects = reg.projects.filter((p) => p.name !== old);
  if (!getProjectEntry(reg, next)) {
    reg.projects.push({ name: next, maxOpen: null, createdAt: now(), updatedAt: now() });
  }
  reg.updatedAt = now();
  saveRegistry(reg);

  return { liveRenamed, archivedRenamed, merged, newName: next };
}
```

- [ ] **Step 3: Write `test/registry.test.mts`**

```ts
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = ""): void { if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); } }
function eq<T>(name: string, got: T, want: T): void { ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`); }

const tmp = mkdtempSync(join(tmpdir(), "armory-reg-"));
process.env.TODO_DIR = tmp;

const { loadRegistry, saveRegistry, reconcileRegistry, getProjectEntry, setProjectMaxOpen, renameProject } = await import("../src/registry.ts");
const { addTodo, listTodos, type Todo } = await import("../src/todo-store.ts");
const { saveArchive, type ArchiveStore } = await import("../src/archive.ts");

// --- loadRegistry: missing → empty, no file created ---
const r0 = loadRegistry();
eq("missing registry → empty", r0.projects.length, 0);
ok("missing registry → no file yet", !existsSync(join(tmp, "projects.json")));

// --- saveRegistry: atomic + 0600 + version 1 ---
saveRegistry({ version: 1, updatedAt: "x", projects: [{ name: "pi", maxOpen: 5, createdAt: "x", updatedAt: "x" }] });
const r1 = loadRegistry();
eq("saved registry reloads name", r1.projects[0]!.name, "pi");
eq("saved registry reloads maxOpen", r1.projects[0]!.maxOpen, 5);
eq("registry version 1", r1.version, 1);
const mode = statSync(join(tmp, "projects.json")).mode & 0o777;
ok("registry file mode 0600", mode === 0o600, `(mode ${mode.toString(8)})`);

// --- reconcileRegistry: appends unknown from live + archive, idempotent ---
const a = addTodo({ title: "T1", project: "getpipher" });
const arch0: ArchiveStore = { version: 3, updatedAt: "x", todos: [{ ...a, project: "bug-bounty", status: "done", closedAt: "x" }] };
saveArchive(arch0);
let reg = loadRegistry();
const res1 = reconcileRegistry(reg, listTodos({ status: "all", limit: 200 }), arch0.todos);
ok("reconcile changed (2 new)", res1.changed && res1.reg.projects.length === 2);
const res2 = reconcileRegistry(res1.reg, listTodos({ status: "all", limit: 200 }), arch0.todos);
ok("reconcile idempotent", !res2.changed);

// --- reconcile ignores empty-string project ---
addTodo({ title: "T2", project: "" });
const res3 = reconcileRegistry(res1.reg, listTodos({ status: "all", limit: 200 }), arch0.todos);
ok("reconcile no (no project) entry", !res3.reg.projects.some((p) => p.name === ""));

// --- getProjectEntry hit/miss ---
ok("getProjectEntry hit", getProjectEntry(res3.reg, "getpipher") !== undefined);
ok("getProjectEntry miss", getProjectEntry(res3.reg, "nope") === undefined);

// --- setProjectMaxOpen: create-if-unknown, set number, null clears ---
const e1 = setProjectMaxOpen(res3.reg, "getpipher", 8);
eq("setMaxOpen sets 8", e1.maxOpen, 8);
const e2 = setProjectMaxOpen(res3.reg, "brand-new", 3);
ok("setMaxOpen creates unknown", getProjectEntry(res3.reg, "brand-new") !== undefined && e2.maxOpen === 3);
const e3 = setProjectMaxOpen(res3.reg, "getpipher", null);
eq("setMaxOpen null clears", e3.maxOpen, null);
let threw = false;
try { setProjectMaxOpen(res3.reg, "", 5); } catch { threw = true; }
ok("setMaxOpen '' throws", threw);
let threw2 = false;
try { setProjectMaxOpen(res3.reg, "x", -1); } catch { threw2 = true; }
ok("setMaxOpen negative throws", threw2);

// --- renameProject: rewrites live + archive + registry; merge; self no-op ---
// (fresh isolated registry for rename tests)
rmSync(join(tmp, "projects.json"), { force: true });
addTodo({ title: "R1", project: "getpither" });
addTodo({ title: "R2", project: "getpither" });
const arch1: ArchiveStore = { version: 3, updatedAt: "x", todos: [{ ...a, project: "getpither", status: "done", closedAt: "x" }] };
saveArchive(arch1);
let regR = loadRegistry();
reconcileRegistry(regR, listTodos({ status: "all", limit: 200 }), loadArchiveAsync().todos);
saveRegistry(regR);
// merge: getpither → getpipher (getpipher already exists from earlier? no — fresh. so create)
const rr = renameProject("getpither", "getpipher");
eq("rename liveRenamed", rr.liveRenamed, 2);
eq("rename archivedRenamed", rr.archivedRenamed, 1);
ok("rename to-new → merged=false", !rr.merged);
ok("rename removed old entry", getProjectEntry(loadRegistry(), "getpither") === undefined);
ok("rename created new entry", getProjectEntry(loadRegistry(), "getpipher") !== undefined);

// self-rename no-op
const self = renameProject("getpipher", "getpipher");
eq("self-rename liveRenamed 0", self.liveRenamed, 0);
eq("self-rename merged false", self.merged, false);

// rename onto existing = merge
addTodo({ title: "R3", project: "alpha" });
addTodo({ title: "R4", project: "beta" });
let regM = loadRegistry();
reconcileRegistry(regM, listTodos({ status: "all", limit: 200 }), loadArchiveAsync().todos);
saveRegistry(regM);
const mr = renameProject("alpha", "beta");
ok("merge → merged=true", mr.merged);
ok("merge removed alpha entry", getProjectEntry(loadRegistry(), "alpha") === undefined);

// rename unknown old → throws
let threw3 = false;
try { renameProject("does-not-exist", "x"); } catch { threw3 = true; }
ok("rename unknown throws", threw3);

// --- corrupt registry → backup + fresh empty ---
writeFileSync(join(tmp, "projects.json"), "{ not json", "utf8");
const recovered = loadRegistry();
eq("corrupt registry → empty", recovered.projects.length, 0);

function loadArchiveAsync() { return (loadArchive as any)() as ArchiveStore; }

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 4: Run registry tests — verify pass**

Run: `node test/registry.test.mts`
Expected: `22 passed, 0 failed` (adjust count to actual; the suite has ~22 assertions).

- [ ] **Step 5: Confirm baseline suites still green**

Run: `npm test`
Expected: all 10 suites green (255 prior + new registry suite).

- [ ] **Step 6: Commit**

```bash
git add src/levenshtein.ts src/registry.ts test/registry.test.mts
git commit -m "feat(registry): project registry (projects.json) + levenshtein helper"
```

---

## Task 2: `src/paths.ts` — extract `getRegistryPath()`

**Files:**
- Modify: `src/paths.ts` (add `getRegistryPath` after `getConfigPath`)
- Modify: `src/registry.ts` (replace inline `join(getTodoDir(), "projects.json")` with `getRegistryPath()` import)

**Interfaces:**
- Produces: `getRegistryPath(): string` (centralized; `registry.ts` consumes it).

- [ ] **Step 1: Add `getRegistryPath` to `src/paths.ts`**

Edit `src/paths.ts` — update the module doc comment's file list + add the function. Replace:

```ts
export function getConfigPath(): string {
  return join(getTodoDir(), "todo.config.json");
}
```

with:

```ts
export function getConfigPath(): string {
  return join(getTodoDir(), "todo.config.json");
}

export function getRegistryPath(): string {
  return join(getTodoDir(), "projects.json");
}
```

And update the header file list comment to add the `projects.json` line.

- [ ] **Step 2: Swap `registry.ts` to use `getRegistryPath`**

In `src/registry.ts`, replace:

```ts
import { dirname, join } from "node:path";
import { getTodoDir } from "./paths.ts";
```

with:

```ts
import { dirname } from "node:path";
import { getRegistryPath } from "./paths.ts";
```

and replace the `getRegistryPath` function body:

```ts
export function getRegistryPath(): string {
  return join(getTodoDir(), "projects.json");
}
```

with a re-export (so `registry.ts` still exports `getRegistryPath` for the extension/tests):

```ts
export { getRegistryPath } from "./paths.ts";
```

- [ ] **Step 3: Run registry tests + baseline — verify still green**

Run: `node test/registry.test.mts && npm test`
Expected: all green (behavior unchanged; refactor only).

- [ ] **Step 4: Commit**

```bash
git add src/paths.ts src/registry.ts
git commit -m "refactor(paths): centralize getRegistryPath in paths.ts"
```

---

## Task 3: `src/projects.ts` + overview tests

**Files:**
- Create: `src/projects.ts`
- Create: `test/projects.test.mts`

**Interfaces:**
- Consumes: `loadStore()` (`src/todo-store.ts`), `loadArchive()` (`src/archive.ts`), `loadRegistry()`/`reconcileRegistry()`/`saveRegistry()`/`getProjectEntry()` (`src/registry.ts`), `levenshtein()` (`src/levenshtein.ts`).
- Produces: `ProjectOverviewRow`, `ProjectsOverview`, `projectsOverview()`.

- [ ] **Step 1: Write `src/projects.ts`**

```ts
// Per-project scope overview for armory-todo (Feature A). Pure read that
// reconciles the registry first (lazy sync), then aggregates counts across
// the live store + archived done. The `projects` action + panel Projects tab
// + the per-project health flags all consume this shape (or its derivatives).

import { loadStore, type Todo } from "./todo-store.ts";
import { loadArchive } from "./archive.ts";
import { loadRegistry, reconcileRegistry, saveRegistry, getProjectEntry } from "./registry.ts";
import { levenshtein } from "./levenshtein.ts";

export interface ProjectOverviewRow {
  name: string;
  open: number;
  in_progress: number;
  parked: number;
  done: number;       // live done + archived done
  total: number;      // open + in_progress + parked + done
  maxOpen: number | null;
  over: boolean;      // open > maxOpen (only when maxOpen !== null)
  typo: boolean;      // total === 1 AND a near-sibling (levenshtein ≤ 2) exists
  lastUpdated: string; // max updatedAt across the project's live todos (ISO), or "" if none
}

export interface ProjectsOverview {
  rows: ProjectOverviewRow[];   // sorted: open desc → total desc → name asc
  totalTodos: number;           // sum of rows' total
  noProject: { count: number; open: number };  // the (no project) bucket, not a row
}

function aggregate(todos: Todo[], archivedDone: Todo[]): Map<string, Todo[]> {
  const by = new Map<string, Todo[]>();
  for (const t of todos) {
    const key = t.project.trim();
    const list = by.get(key) ?? [];
    list.push(t);
    by.set(key, list);
  }
  for (const t of archivedDone) {
    const key = t.project.trim();
    if (!by.has(key)) by.set(key, []);   // archived done still counts toward total/done
  }
  return by;
}

export function projectsOverview(): ProjectsOverview {
  const live = loadStore();
  const archive = loadArchive();
  const archivedDone = archive.todos.filter((t) => t.status === "done");

  // reconcile registry first (lazy sync), persist iff changed
  const reg = loadRegistry();
  const { reg: synced, changed } = reconcileRegistry(reg, live.todos, archive.todos);
  if (changed) saveRegistry(synced);

  const by = aggregate(live.todos, archivedDone);
  const names = [...by.keys()].filter((n) => n !== "").sort();

  let totalTodos = 0;
  const rows: ProjectOverviewRow[] = [];
  for (const name of names) {
    const liveForName = live.todos.filter((t) => t.project.trim() === name);
    const archivedDoneForName = archivedDone.filter((t) => t.project.trim() === name);
    const open = liveForName.filter((t) => t.status === "open").length;
    const in_progress = liveForName.filter((t) => t.status === "in_progress").length;
    const parked = liveForName.filter((t) => t.status === "parked").length;
    const done = liveForName.filter((t) => t.status === "done").length + archivedDoneForName.length;
    const total = open + in_progress + parked + done;
    totalTodos += total;
    const entry = getProjectEntry(synced, name);
    const maxOpen = entry?.maxOpen ?? null;
    const over = maxOpen !== null && open > maxOpen;
    const lastUpdated = liveForName.length
      ? liveForName.map((t) => t.updatedAt).sort().at(-1) ?? ""
      : "";
    rows.push({ name, open, in_progress, parked, done, total, maxOpen, over, typo: false, lastUpdated });
  }

  // typo: total === 1 AND a near-sibling (levenshtein ≤ 2) among other names
  for (const row of rows) {
    if (row.total === 1) {
      row.typo = names.some((other) => other !== row.name && levenshtein(row.name, other) <= 2);
    }
  }

  // (no project) bucket
  const noProjectLive = live.todos.filter((t) => t.project.trim() === "");
  const noProjectArchivedDone = archivedDone.filter((t) => t.project.trim() === "");
  const noProject = {
    count: noProjectLive.length + noProjectArchivedDone.length,
    open: noProjectLive.filter((t) => t.status === "open").length,
  };

  rows.sort((a, b) => b.open - a.open || b.total - a.total || a.name.localeCompare(b.name));
  return { rows, totalTodos, noProject };
}
```

- [ ] **Step 2: Write `test/projects.test.mts`**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = ""): void { if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); } }
function eq<T>(name: string, got: T, want: T): void { ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`); }

const tmp = mkdtempSync(join(tmpdir(), "armory-proj-"));
process.env.TODO_DIR = tmp;

const { projectsOverview } = await import("../src/projects.ts");
const { addTodo, updateTodo, completeTodo } = await import("../src/todo-store.ts");
const { saveArchive } = await import("../src/archive.ts");
const { setProjectMaxOpen, loadRegistry, saveRegistry } = await import("../src/registry.ts");

// --- empty store → empty overview ---
const o0 = projectsOverview();
eq("empty rows", o0.rows.length, 0);
eq("empty totalTodos", o0.totalTodos, 0);
eq("empty noProject count", o0.noProject.count, 0);

// --- counts across live + archived done ---
addTodo({ title: "a", project: "pi" });
addTodo({ title: "b", project: "pi" });
const ip = addTodo({ title: "c", project: "pi" });
updateTodo(ip.id, { status: "in_progress" });
const done1 = addTodo({ title: "d", project: "pi" });
completeTodo(done1.id);                    // live done
addTodo({ title: "e", project: "sip" });   // open, separate project
addTodo({ title: "f", project: "" });      // (no project)

// archived done for "pi"
saveArchive({ version: 3, updatedAt: "x", todos: [{ ...done1, project: "pi", status: "done", closedAt: "2026-07-01T00:00:00.000Z" }] });

const o1 = projectsOverview();
const pi = o1.rows.find((r) => r.name === "pi")!;
const sip = o1.rows.find((r) => r.name === "sip")!;
eq("pi open", pi.open, 2);
eq("pi in_progress", pi.in_progress, 1);
eq("pi parked", pi.parked, 0);
eq("pi done (live done + archived done)", pi.done, 1 + 1);
eq("pi total", pi.total, 5);
eq("sip open", sip.open, 1);
eq("noProject count", o1.noProject.count, 1);
eq("noProject open", o1.noProject.open, 1);

// --- sort: open desc → total desc → name asc ---
addTodo({ title: "g", project: "alpha" });
addTodo({ title: "h", project: "alpha" });   // alpha: 2 open
const o2 = projectsOverview();
eq("first row is pi (3 actionable open)", o2.rows[0]!.name, "pi");
ok("sort then total/name", o2.rows.length >= 3);

// --- maxOpen + over flag ---
let reg = loadRegistry();
setProjectMaxOpen(reg, "sip", 0);   // maxOpen 0 → any open is over
saveRegistry(reg);
const o3 = projectsOverview();
const sip3 = o3.rows.find((r) => r.name === "sip")!;
eq("sip maxOpen 0", sip3.maxOpen, 0);
ok("sip over (1 > 0)", sip3.over);

// --- typo: 1-todo project with near-sibling ---
addTodo({ title: "z", project: "getpither" });   // 1 todo, near "getpipher"?
addTodo({ title: "y", project: "getpipher" });    // sibling
const o4 = projectsOverview();
const typo = o4.rows.find((r) => r.name === "getpither")!;
ok("getpither typo (near getpipher)", typo.typo);
const notTypo = o4.rows.find((r) => r.name === "getpipher")!;
ok("getpipher not typo (>1 todo)", !notTypo.typo);

// --- lastUpdated = max live updatedAt, "" if no live todos ---
const o5 = projectsOverview();
ok("pi lastUpdated non-empty", o5.rows.find((r) => r.name === "pi")!.lastUpdated.length > 0);

// --- registry seeded via reconcile (projectsOverview persists) ---
ok("registry has getpither", loadRegistry().projects.some((p) => p.name === "getpither"));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 3: Run projects tests — verify pass**

Run: `node test/projects.test.mts`
Expected: ~16 passed, 0 failed.

- [ ] **Step 4: Full suite green**

Run: `npm test`
Expected: 11 suites green.

- [ ] **Step 5: Commit**

```bash
git add src/projects.ts test/projects.test.mts
git commit -m "feat(projects): per-project scope overview (counts + maxOpen + typo)"
```

---

## Task 4: `src/config.ts` — add `perProjectDefaultMax`

**Files:**
- Modify: `src/config.ts` — `HealthConfig` + `DEFAULT_CONFIG.health` + (no version bump).
- Modify: `test/todo-config.test.mts` — assert default 8 + forward-compatible merge.

**Interfaces:**
- Produces: `HealthConfig.perProjectDefaultMax: number` (default 8).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test additions in `test/todo-config.test.mts`**

Add after the existing defaults block:

```ts
eq("default perProjectDefaultMax 8", DEFAULT_CONFIG.health.perProjectDefaultMax, 8);

// forward-compatible merge: an old config without the field gets the default
saveConfig({ version: 1, prune: DEFAULT_CONFIG.prune, health: { ...DEFAULT_CONFIG.health, perProjectDefaultMax: undefined } } as any);
const merged = loadConfig();
eq("missing perProjectDefaultMax → default 8", merged.health.perProjectDefaultMax, 8);
```

- [ ] **Step 2: Run — verify fails**

Run: `node test/todo-config.test.mts`
Expected: FAIL — `DEFAULT_CONFIG.health.perProjectDefaultMax` is `undefined` (type error / eq fails).

- [ ] **Step 3: Add the field to `src/config.ts`**

In `src/config.ts`, extend `HealthConfig`:

```ts
export interface HealthConfig {
  activeMaxOpen: number;
  activeStaleDays: number;
  parkedMax: number;
  parkedStaleDays: number;
  archiveMax: number;
  archiveOldDays: number;
  perProjectDefaultMax: number;  // v0.4.0: per-project PROJECT_LARGE threshold (advisory)
}
```

and `DEFAULT_CONFIG`:

```ts
  health: {
    activeMaxOpen: 15,
    activeStaleDays: 30,
    parkedMax: 10,
    parkedStaleDays: 60,
    archiveMax: 200,
    archiveOldDays: 180,
    perProjectDefaultMax: 8,
  },
```

(The existing `loadConfig` merge `{ ...DEFAULT_CONFIG.health, ...parsed.health }` fills `perProjectDefaultMax` for old configs automatically — but `undefined` in the spread would *overwrite* the default. Handle it explicitly:)

In `loadConfig`'s merge, replace:

```ts
    return {
      version: 1,
      prune: { ...DEFAULT_CONFIG.prune, ...parsed.prune },
      health: { ...DEFAULT_CONFIG.health, ...parsed.health },
    };
```

with:

```ts
    const health = { ...DEFAULT_CONFIG.health, ...parsed.health };
    if (health.perProjectDefaultMax === undefined) health.perProjectDefaultMax = DEFAULT_CONFIG.health.perProjectDefaultMax;
    return {
      version: 1,
      prune: { ...DEFAULT_CONFIG.prune, ...parsed.prune },
      health,
    };
```

- [ ] **Step 4: Run config tests — verify pass**

Run: `node test/todo-config.test.mts`
Expected: 17 passed (15 prior + 2 new), 0 failed.

- [ ] **Step 5: Full suite green**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/todo-config.test.mts
git commit -m "feat(config): perProjectDefaultMax health threshold (default 8)"
```

---

## Task 5: `src/health.ts` — 4 per-project flags + reconcile-first

**Files:**
- Modify: `src/health.ts` — new flags + `ProjectHealth[]` + `noProject` + suggestions; reconcile-first.
- Modify: `test/todo-health.test.mts` — per-project flag coverage.

**Interfaces:**
- Consumes: `loadRegistry`/`reconcileRegistry`/`saveRegistry`/`getProjectEntry` (`src/registry.ts`), `levenshtein` (`src/levenshtein.ts`).
- Produces: `HealthFlag` += `PROJECT_OVER | PROJECT_TYPO | PROJECT_LARGE | PROJECT_STALE`; `HealthReport.projects: ProjectHealth[]`; `HealthReport.noProject: { open: number }`.

- [ ] **Step 1: Write failing test additions in `test/todo-health.test.mts`**

Append (after existing assertions, before `rmSync`):

```ts
// --- per-project flags (v0.4.0) ---
const { setProjectMaxOpen, loadRegistry, saveRegistry } = await import("../src/registry.ts");
const { addTodo, updateTodo, completeTodo } = await import("../src/todo-store.ts");

// PROJECT_OVER: maxOpen set + exceeded
addTodo({ title: "p1", project: "over-proj" });
addTodo({ title: "p2", project: "over-proj" });   // 2 open
let reg = loadRegistry();
setProjectMaxOpen(reg, "over-proj", 1);            // max 1 → 2 is over
saveRegistry(reg);

// PROJECT_LARGE: open > perProjectDefaultMax (8) with maxOpen null
for (let i = 0; i < 9; i++) addTodo({ title: `large-${i}`, project: "large-proj" });

// PROJECT_TYPO: 1 todo + near-sibling
addTodo({ title: "typo", project: "getpither" });
addTodo({ title: "sib", project: "getpipher" });

// PROJECT_STALE: lastUpdated > activeStaleDays (30)
const stale = addTodo({ title: "stale", project: "stale-proj" });
updateTodo(stale.id, {} as any);  // touch updatedAt? — instead write an old updatedAt via store reload not needed; skip stale assertion if hard to forge

const report2 = healthReport();
const overFlag = report2.flags.includes("PROJECT_OVER");
const largeFlag = report2.flags.includes("PROJECT_LARGE");
const typoFlag = report2.flags.includes("PROJECT_TYPO");
ok("PROJECT_OVER flag", overFlag);
ok("PROJECT_LARGE flag (9 > 8)", largeFlag);
ok("PROJECT_TYPO flag", typoFlag);
ok("health.projects populated", report2.projects.length > 0);
ok("noProject reported", typeof report2.noProject.open === "number");
ok("suggestion mentions rename for typo", report2.suggestions.some((s) => s.includes("rename")));
```

> **Note on PROJECT_STALE:** forging a `lastUpdated > 30d` without time mocking is fiddly. If a stale assertion is impractical in the existing harness (no clock mock), skip the stale *flag* assertion in tests and rely on the manual QA gate + code review for that flag. The stale *logic* is simple (`daysAgo(lastUpdated) > activeStaleDays`) and covered by inspection. Add a stale test only if a clock-injection helper already exists in the suite (it does not — check first).

- [ ] **Step 2: Run — verify fails**

Run: `node test/todo-health.test.mts`
Expected: FAIL — `report2.flags`/`report2.projects`/`report2.noProject` undefined.

- [ ] **Step 3: Implement per-project flags in `src/health.ts`**

Update `HealthFlag`:

```ts
export type HealthFlag =
  | "ACTIVE_LARGE" | "ACTIVE_STALE"
  | "PARKED_LARGE" | "PARKED_STALE"
  | "ARCHIVE_LARGE" | "ARCHIVE_OLD"
  | "PROJECT_OVER" | "PROJECT_TYPO" | "PROJECT_LARGE" | "PROJECT_STALE";
```

Add `ProjectHealth` + extend `HealthReport`:

```ts
export interface ProjectHealth {
  name: string;
  open: number;
  maxOpen: number | null;
  over: boolean;
  typo: boolean;
  large: boolean;
  stale: boolean;
  lastUpdated: string;
}

export interface HealthReport {
  active: ActiveHealth;
  parked: ParkedHealth;
  archive: ArchiveHealth;
  notesBytes: NotesBytes;
  flags: HealthFlag[];
  suggestions: string[];
  projects: ProjectHealth[];   // only projects with ≥1 flag, sorted open desc
  noProject: { open: number };  // (no project) open count, for context
}
```

Add imports at top of `src/health.ts`:

```ts
import { loadRegistry, reconcileRegistry, saveRegistry, getProjectEntry } from "./registry.ts";
import { levenshtein } from "./levenshtein.ts";
```

In `healthReport()`, **before** the existing diagnostics (so the registry is reconciled first), add:

```ts
  // reconcile registry first (lazy sync), persist iff changed
  const reg = loadRegistry();
  const { reg: synced, changed } = reconcileRegistry(reg, live.todos, archive.todos);
  if (changed) saveRegistry(synced);
```

After the existing `flags`/`suggestions` blocks (before `return`), add the per-project computation:

```ts
  // per-project flags
  const archivedDone = archive.todos.filter((t) => t.status === "done");
  const names = new Set<string>();
  for (const t of live.todos) { const p = t.project.trim(); if (p) names.add(p); }
  for (const t of archivedDone) { const p = t.project.trim(); if (p) names.add(p); }

  const projectHealth: ProjectHealth[] = [];
  for (const name of names) {
    const liveForName = live.todos.filter((t) => t.project.trim() === name);
    const open = liveForName.filter((t) => t.status === "open").length;
    const entry = getProjectEntry(synced, name);
    const maxOpen = entry?.maxOpen ?? null;
    const over = maxOpen !== null && open > maxOpen;
    const large = open > h.perProjectDefaultMax;
    const lastUpdated = liveForName.length ? liveForName.map((t) => t.updatedAt).sort().at(-1) ?? "" : "";
    const stale = lastUpdated !== "" && daysAgo(lastUpdated) > h.activeStaleDays;
    const totalForName = liveForName.length + archivedDone.filter((t) => t.project.trim() === name).length;
    const typo = totalForName === 1 && [...names].some((o) => o !== name && levenshtein(name, o) <= 2);
    if (over || large || stale || typo) {
      projectHealth.push({ name, open, maxOpen, over, typo, large, stale, lastUpdated });
    }
  }
  projectHealth.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));

  for (const p of projectHealth) {
    if (p.over) { flags.push("PROJECT_OVER"); suggestions.push(`project '${p.name}' ${p.open} open (maxOpen ${p.maxOpen}) → close/park some, or raise maxOpen`); }
    if (p.large) { flags.push("PROJECT_LARGE"); suggestions.push(`project '${p.name}' ${p.open} open (per-project default max ${h.perProjectDefaultMax}) → over budget`); }
    if (p.stale) { flags.push("PROJECT_STALE"); suggestions.push(`project '${p.name}' untouched > ${h.activeStaleDays}d → park or close`); }
    if (p.typo) {
      flags.push("PROJECT_TYPO");
      const sib = [...names].find((o) => o !== p.name && levenshtein(p.name, o) <= 2);
      suggestions.push(`project '${p.name}' has 1 todo — possible typo of '${sib}'? → todo project rename ${p.name} ${sib}`);
    }
  }

  const noProject = { open: live.todos.filter((t) => t.project.trim() === "" && t.status === "open").length };
```

Update the `return` statement to include `projects: projectHealth, noProject`.

- [ ] **Step 4: Run health tests — verify pass**

Run: `node test/todo-health.test.mts`
Expected: prior count + ~7 new assertions, 0 failed.

- [ ] **Step 5: Full suite green**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/health.ts test/todo-health.test.mts
git commit -m "feat(health): per-project flags (OVER/TYPO/LARGE/STALE) + reconcile-first"
```

---

## Task 6: `src/panel-data.ts` — project row + action helpers + tests

**Files:**
- Modify: `src/panel-data.ts` — add `projectOverviewToItems`, `actionsForProject`, `noProjectSummaryItem`.
- Modify: `test/panel-data.test.mts` — project helper coverage.

**Interfaces:**
- Consumes: `ProjectsOverview`/`ProjectOverviewRow` (`src/projects.ts`).
- Produces: `projectOverviewToItems(overview): SelectItem[]`, `actionsForProject(): {label, action}[]`, `noProjectSummaryItem(overview): SelectItem`.

- [ ] **Step 1: Write failing tests in `test/panel-data.test.mts`**

Append:

```ts
import { projectOverviewToItems, actionsForProject, noProjectSummaryItem } from "../src/panel-data.ts";
import type { ProjectsOverview } from "../src/projects.ts";

const overview: ProjectsOverview = {
  rows: [
    { name: "pi", open: 3, in_progress: 0, parked: 0, done: 1, total: 4, maxOpen: 2, over: true, typo: false, lastUpdated: "2026-07-21T00:00:00.000Z" },
    { name: "getpither", open: 0, in_progress: 0, parked: 0, done: 0, total: 1, maxOpen: null, over: false, typo: true, lastUpdated: "" },
  ],
  totalTodos: 5,
  noProject: { count: 2, open: 1 },
};

const items = projectOverviewToItems(overview);
ok("project item label has name", items[0]!.label.includes("pi"));
ok("project item value is name", items[0]!.value === "pi");
ok("OVER marker rendered", items[0]!.label.includes("OVER"));
ok("typo marker rendered", items[1]!.label.includes("typo"));

const acts = actionsForProject();
ok("actions include Rename", acts.some((a) => a.action === "rename"));
ok("actions include Set maxOpen", acts.some((a) => a.action === "setmax"));
ok("actions include Filter", acts.some((a) => a.action === "filter"));

const np = noProjectSummaryItem(overview);
ok("no-project summary value is __noproject__", np.value === "__noproject__");
ok("no-project summary label has count", np.label.includes("2"));
```

- [ ] **Step 2: Run — verify fails**

Run: `node test/panel-data.test.mts`
Expected: FAIL — imports not found.

- [ ] **Step 3: Add helpers to `src/panel-data.ts`**

Append:

```ts
import type { ProjectsOverview, ProjectOverviewRow } from "./projects.ts";

/** Format the projects overview into SelectList items. Markers: OVER / typo. */
export function projectOverviewToItems(o: ProjectsOverview): SelectItem[] {
  return o.rows.map((r) => {
    const cap = r.maxOpen !== null ? ` [max:${r.maxOpen}]` : "";
    const over = r.over ? " OVER" : "";
    const typo = r.typo ? " ?typo" : "";
    const last = r.lastUpdated ? ` · ${r.lastUpdated.slice(0, 10)}` : " · (no live)";
    return {
      value: r.name,
      label: `${r.name}  ${r.open}/${r.in_progress}/${r.parked}/${r.done} (total ${r.total})${cap}${over}${typo}${last}`,
    };
  });
}

/** Actions for a project row in the Projects tab. */
export function actionsForProject(): { label: string; action: string }[] {
  return [
    { label: "Rename / merge", action: "rename" },
    { label: "Set maxOpen", action: "setmax" },
    { label: "Filter active to project", action: "filter" },
  ];
}

/** The (no project) summary row — non-selectable (no submenu). */
export function noProjectSummaryItem(o: ProjectsOverview): SelectItem {
  return { value: "__noproject__", label: `(no project): ${o.noProject.count} total · ${o.noProject.open} open` };
}
```

- [ ] **Step 4: Run panel-data tests — verify pass**

Run: `node test/panel-data.test.mts`
Expected: 31 prior + ~8 new, 0 failed.

- [ ] **Step 5: Full suite green**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/panel-data.ts test/panel-data.test.mts
git commit -m "feat(panel-data): project overview items + action submenu helpers"
```

---

## Task 7: `src/panel.ts` — 6th tab `projects` + action submenu (Rename/Set maxOpen/Filter)

**Files:**
- Modify: `src/panel.ts` — `Box` type + `BOXES`, `refreshList`, `onItemSelect`, `openActionSubmenu`, `executeAction`, `renderShell` branch, inline-`Input` for Rename + Set maxOpen, a `projectFilterName` field for the Filter action.
- Manual-gate only (no unit test — `panel.ts` is the one non-unit-tested component; covered by the autonomous tmux QA in Task 9).

**Interfaces:**
- Consumes: `projectsOverview` (`src/projects.ts`), `renameProject`/`setProjectMaxOpen`/`loadRegistry` (`src/registry.ts`), `projectOverviewToItems`/`actionsForProject`/`noProjectSummaryItem` (`src/panel-data.ts`).

- [ ] **Step 1: Extend `Box` + `BOXES`**

In `src/panel.ts`, replace:

```ts
export type Box = "active" | "parked" | "done" | "archive" | "config";
const BOXES: Box[] = ["active", "parked", "done", "archive", "config"];
```

with:

```ts
export type Box = "active" | "parked" | "done" | "archive" | "projects" | "config";
const BOXES: Box[] = ["active", "parked", "done", "archive", "projects", "config"];
```

- [ ] **Step 2: Add imports + a `projectFilterName` field + edit-mode variants**

Add to the imports block:

```ts
import { projectsOverview } from "./projects.ts";
import { renameProject, setProjectMaxOpen, loadRegistry, saveRegistry } from "./registry.ts";
import { projectOverviewToItems, actionsForProject, noProjectSummaryItem } from "./panel-data.ts";
```

Add fields near the other private fields:

```ts
  private projectFilterName = "";     // set by the "Filter active to project" action
  private projectEditKind: "rename" | "setmax" | null = null;
  private projectEditName = "";      // which project is being edited
```

- [ ] **Step 3: Extend `refreshList` with the `projects` branch**

In `refreshList()`, add before the closing brace (after the `archive` branch):

```ts
    } else if (this.currentBox === "projects") {
      const overview = projectsOverview();
      const rows = projectOverviewToItems(overview);
      // prepend the (no project) summary as a non-actionable first row
      this.setSelectItems([noProjectSummaryItem(overview), ...rows]);
    }
```

- [ ] **Step 4: Extend `onItemSelect` to guard the `(no project)` row + route to the project submenu**

In `onItemSelect`, add at the top (before `this.openActionSubmenu(item.value)`):

```ts
    if (this.currentBox === "projects" && item.value === "__noproject__") {
      // summary row — no submenu
      return;
    }
    if (this.currentBox === "projects") {
      this.openProjectSubmenu(item.value);
      return;
    }
```

- [ ] **Step 5: Add `openProjectSubmenu` + the rename/setmax inline-Input flow**

Add new methods (mirroring `openActionSubmenu`/`executeAction`):

```ts
  private openProjectSubmenu(name: string): void {
    const acts = actionsForProject();
    const items: SelectItem[] = acts.map((a) => ({ value: a.action, label: a.label }));
    this.actionList = new SelectList(items, 8, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("warning", s),
    });
    this.actionList.onSelect = (a) => this.executeProjectAction(name, a.value);
    this.actionList.onCancel = () => { this.actionMode = false; this.actionList = null; this.renderShell(); };
    this.actionMode = true;
    this.renderShell();
  }

  private async executeProjectAction(name: string, action: string): Promise<void> {
    try {
      if (action === "filter") {
        this.projectFilterName = name;
        this.currentBox = "active";
        this.filterInput.setValue(`(${name})`);   // the active tab's filter is free-text; we set a project-scoped hint
        // NOTE: listTodos filter is exact project match — the panel's filterInput is a text search, not a project filter.
        // For an exact project scope, we store projectFilterName and refreshList honors it in the active branch.
        this.actionMode = false; this.actionList = null;
        this.refreshList();
        this.renderShell();
        return;
      }
      if (action === "rename" || action === "setmax") {
        this.projectEditKind = action;
        this.projectEditName = name;
        this.editInput = new Input();
        this.editInput.setValue(action === "rename" ? name : "");
        this.editInput.onSubmit = (value) => {
          try {
            if (this.projectEditKind === "rename") {
              const r = renameProject(this.projectEditName, value.trim());
              this.onNotify(`Renamed ${this.projectEditName} → ${r.newName} (${r.liveRenamed} live + ${r.archivedRenamed} archived${r.merged ? ", merged" : ""})`);
            } else if (this.projectEditKind === "setmax") {
              const v = value.trim().toLowerCase();
              const max = v === "clear" || v === "" ? null : Number(v);
              if (!Number.isFinite(max) && max !== null) throw new Error("maxOpen must be a number or 'clear'");
              const reg = loadRegistry();
              setProjectMaxOpen(reg, this.projectEditName, max);
              saveRegistry(reg);
              this.onNotify(`${this.projectEditName} maxOpen = ${max === null ? "cleared" : max}`);
            }
          } catch (err) { this.onNotify((err as Error).message, "error"); }
          this.exitProjectEdit();
        };
        this.editInput.onEscape = () => this.exitProjectEdit();
        this.actionMode = false; this.actionList = null;
        this.editMode = true;
        this.renderShell();
        return;
      }
    } catch (err) {
      this.onNotify((err as Error).message, "error");
    }
    this.actionMode = false; this.actionList = null;
    this.refreshList();
    this.renderShell();
  }

  private exitProjectEdit(): void {
    this.editMode = false;
    this.editInput = null;
    this.projectEditKind = null;
    this.projectEditName = "";
    this.refreshList();
    this.renderShell();
  }
```

- [ ] **Step 6: Honor `projectFilterName` in the `active` refresh branch**

In `refreshList`, replace the `active` branch:

```ts
    if (this.currentBox === "active") {
      const todos = listTodos({ text: filter || undefined, limit: 50 });
      this.setSelectItems(todos.map(todoToItem));
    }
```

with:

```ts
    if (this.currentBox === "active") {
      const project = this.projectFilterName || undefined;
      const todos = listTodos({ project, text: filter || undefined, limit: 50 });
      this.setSelectItems(todos.map(todoToItem));
      if (this.projectFilterName) {
        // show a one-line scope hint by prepending a non-actionable summary row
        // (SelectList rows are SelectItem; reuse the no-project summary shape)
      }
    }
```

And clear `projectFilterName` in `switchBox` (so switching tabs resets the scope):

```ts
  private switchBox(dir: 1 | -1): void {
    const idx = BOXES.indexOf(this.currentBox);
    const next = (idx + dir + BOXES.length) % BOXES.length;
    this.currentBox = BOXES[next]!;
    this.filterInput.setValue("");
    this.projectFilterName = "";   // reset project scope on tab switch
    this.actionMode = false;
    this.actionList = null;
    this.refreshList();
    this.renderShell();
  }
```

- [ ] **Step 7: Syntax-check the panel + extension**

Run: `node --check src/panel.ts && node --check extensions/todo.ts`
Expected: no output (syntax OK). (tsx compiles on the fly; `node --check` validates syntax only.)

- [ ] **Step 8: Full unit suite green (panel.ts itself is manual-gate)**

Run: `npm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/panel.ts
git commit -m "feat(panel): Projects tab (6th) + Rename/Set maxOpen/Filter actions"
```

---

## Task 8: `extensions/todo.ts` — tool actions `projects` + `project_rename`, `/todo projects` slash, health text

**Files:**
- Modify: `extensions/todo.ts` — `ACTIONS`, parameter schema (`oldName`, `newName`), `execute` switch, slash `projects` subcommand, health text output.

**Interfaces:**
- Consumes: `projectsOverview` (`src/projects.ts`), `renameProject` (`src/registry.ts`).
- Produces: two new tool actions + one new slash sub + extended health text.

- [ ] **Step 1: Extend `ACTIONS` + imports**

In `extensions/todo.ts`, replace:

```ts
const ACTIONS = ["list", "add", "update", "get", "complete", "delete", "clear", "park", "prune", "restore", "health"] as const;
```

with:

```ts
const ACTIONS = ["list", "add", "update", "get", "complete", "delete", "clear", "park", "prune", "restore", "health", "projects", "project_rename"] as const;
```

Add imports near the existing `../src/...` imports:

```ts
import { projectsOverview } from "../src/projects";
import { renameProject } from "../src/registry";
```

- [ ] **Step 2: Add `oldName` + `newName` to the parameter schema**

In the `parameters: Type.Object({...})` block, add (before the closing `}`):

```ts
      // project actions (v0.4.0)
      oldName: Type.Optional(Type.String({ description: "project_rename: current project name" })),
      newName: Type.Optional(Type.String({ description: "project_rename: new project name (merge if it already exists)" })),
```

- [ ] **Step 3: Add the two tool action cases**

In the `switch (params.action)` block, before `default:`, add:

```ts
          case "projects": {
            const o = projectsOverview();
            const rows = o.rows.map((r) => {
              const cap = r.maxOpen !== null ? ` [max:${r.maxOpen}]` : "";
              const over = r.over ? " OVER" : "";
              const typo = r.typo ? " ?typo" : "";
              return `  ${r.name}  ${r.open}o/${r.in_progress}i/${r.parked}p/${r.done}d (total ${r.total})${cap}${over}${typo}`;
            });
            const np = `(no project): ${o.noProject.count} total · ${o.noProject.open} open`;
            const text = rows.length ? `Projects (${o.rows.length}):\n${rows.join("\n")}\n${np}` : `Projects: (none)\n${np}`;
            return { content: [{ type: "text" as const, text }] };
          }
          case "project_rename": {
            if (!params.oldName || !params.newName) {
              return { content: [{ type: "text" as const, text: "Error: `oldName` and `newName` are required for project_rename." }] };
            }
            const r = renameProject(params.oldName, params.newName);
            return { content: [{ type: "text" as const, text: `Renamed ${params.oldName} → ${r.newName}: ${r.liveRenamed} live + ${r.archivedRenamed} archived${r.merged ? " (merged)" : ""}` }] };
          }
```

- [ ] **Step 4: Extend the `health` action text with the `projects:` section**

In the `case "health"` block, replace the `const lines = [...]` with:

```ts
            const projLines = report.projects.length
              ? [`projects:` , ...report.projects.map((p) => {
                  const cap = p.maxOpen !== null ? ` [max:${p.maxOpen}]` : "";
                  const flags = [p.over && "OVER", p.large && "LARGE", p.stale && "STALE", p.typo && "TYPO"].filter(Boolean).join(" ");
                  return `  ${p.name}  ${p.open} open${cap}${flags ? ` ${flags}` : ""}`;
                })]
              : [];
            const lines = [
              `## TODO Health Report`,
              `active:  ${report.active.open} open + ${report.active.in_progress} in_progress (${report.active.stale_30d} stale)`,
              `parked:  ${report.parked.count} (${report.parked.stale_60d} stale)`,
              `archive: ${report.archive.count} (${report.archive.older_180d} old)`,
              `notes:   ${report.notesBytes.total}B total · max ${report.notesBytes.max}B · avg ${report.notesBytes.avg}B`,
              `(no project): ${report.noProject.open} open`,
              report.flags.length ? `flags: ${report.flags.join(", ")}` : "flags: (none — healthy)",
              ...projLines,
              ...report.suggestions.map((s) => `  → ${s}`),
            ];
```

- [ ] **Step 5: Add the `/todo projects` slash subcommand**

In the slash handler, after the `if (sub === "path")` block, add:

```ts
        if (sub === "projects") {
          const o = projectsOverview();
          const rows = o.rows.map((r) => {
            const cap = r.maxOpen !== null ? ` [max:${r.maxOpen}]` : "";
            const over = r.over ? " OVER" : "";
            const typo = r.typo ? " ?typo" : "";
            return `  ${r.name}  ${r.open}o/${r.in_progress}i/${r.parked}p/${r.done}d (total ${r.total})${cap}${over}${typo}`;
          });
          const np = `(no project): ${o.noProject.count} total · ${o.noProject.open} open`;
          const msg = rows.length ? `Projects (${o.rows.length}):\n${rows.join("\n")}\n${np}` : `Projects: (none)\n${np}`;
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          return;
        }
```

Update the slash `description` string to include `/todo projects`:

```ts
      "Global cross-session TODO list. " +
      "/todo / /todo all / /todo add <title> / /todo done <id> / /todo rm <id> / " +
      "/todo park <id> / /todo restore <id> / /todo prune [--all|--hard --box <b> --older-than <d>] / " +
      "/todo archive [project:X|text:Y] / /todo finished / /todo projects / /todo health / /todo clean / /todo path",
```

- [ ] **Step 6: Extend the slash `health` block to mirror the tool's projects section**

Apply the same `projLines` addition to the slash `if (sub === "health")` block (duplicate the construction; the slash builds its own `lines` array).

- [ ] **Step 7: Syntax-check**

Run: `node --check extensions/todo.ts`
Expected: no output.

- [ ] **Step 8: Full suite green**

Run: `npm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add extensions/todo.ts
git commit -m "feat(extension): projects + project_rename tool actions, /todo projects slash, health projects section"
```

---

## Task 9: README + AGENTS + version bump + autonomous QA gate + ship

**Files:**
- Modify: `README.md` — v0.4.0 section + Known issues.
- Modify: `AGENTS.md` (repo) — v0.4.0 row.
- Modify: `package.json` — version `0.4.0`.

- [ ] **Step 1: README v0.4.0 section**

Add a `## v0.4.0 — Project-Scope Management` section after the v0.3.1 section, summarizing: project registry (`projects.json`), `projects` overview, per-project health flags (`PROJECT_OVER`/`PROJECT_TYPO`/`PROJECT_LARGE`/`PROJECT_STALE`), `maxOpen` advisory slot (enforcement in v0.5.0), interactive Rename/Set maxOpen/Filter in the `/todo` panel's 6th tab, `todo project_rename` tool action, `/todo projects` slash. Add to Known issues: "No caps enforcement yet (count/notes/injection) — lands in v0.5.0."

- [ ] **Step 2: Repo `AGENTS.md` version-table row**

Add a v0.4.0 row to the Common Commands / Notes table mirroring the v0.3.1 row, mentioning the new `projects.json` file in the structure block.

- [ ] **Step 3: Version bump**

In `package.json`, set `"version": "0.4.0"`.

- [ ] **Step 4: Final full suite**

Run: `npm test`
Expected: all suites green (~300+ total).

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md package.json
git commit -m "docs(v0.4.0): project-scope management + version bump"
```

- [ ] **Step 6: RECTOR QA gate (autonomous tmux harness, per v0.3.1 pattern)**

Manual/interactive gate. Using the tmux harness from the v0.3.1 session (isolated pi, temp `TODO_DIR`, `send-keys` + `capture-pane`), verify:
1. `/todo` opens the panel; 6 tabs present, `Projects` is the 5th.
2. Projects tab lists the overview rows + a `(no project)` summary row.
3. Selecting a project → action submenu shows Rename / Set maxOpen / Filter.
4. Rename (incl. merge onto an existing name) rewrites live + archive + registry; notify shows counts.
5. Set maxOpen (number + `clear`) persists; the row's `[max:N]` + `OVER` marker updates.
6. Filter active to project jumps to the active tab scoped to that project.
7. `/todo projects` slash prints the overview text.
8. `todo health` (tool + `/todo health` slash) shows the `projects:` section + per-project flags.
9. `todo project_rename` (tool) returns the rename result.
10. No `/todo project rename` slash exists (rename is panel-only).
11. Baseline regression: existing tabs (active/parked/done/archive/config) unchanged.

- [ ] **Step 7: Push + PR**

```bash
git push -u origin feat/project-scope-management
gh pr create --title "v0.4.0: Project-Scope Management (Workstream C / Feature A)" --body "..." --base main
```

PR body: summary of the 13 locked decisions + a link to the spec + the QA-gate results. After RECTOR approval: `gh pr merge --merge --delete-branch`.

- [ ] **Step 8: Tag → CI auto-publish**

```bash
git checkout main && git pull
git tag -am "v0.4.0 — project-scope management (registry + projects overview + per-project health + rename/merge)" v0.4.0
git push origin v0.4.0
```

CI (`release.yml`) auto-publishes npm `@getpipher/armory-todo@0.4.0` + auto-creates the GitHub Release (the workflow step added in v0.3.0-post). Verify: `npm view @getpipher/armory-todo version` → `0.4.0`; GitHub Releases shows `v0.4.0`.

- [ ] **Step 9: Update `~/.pi/agent/settings.json` + record memory**

```bash
# pin the new version (force @0.4.0 to dodge the npm cache)
pi install npm:@getpipher/armory-todo@0.4.0
```

Write `~/.pi/agent/memory/-Users-rector-local-dev-getpipher-armory-todo/v0.4.0-shipped.md` (gotchas + decisions), mirroring the v0.3.0/v0.3.1 memory files. Update the repo `AGENTS.md` test counts.

---

## Self-Review (run after writing, before handoff)

**1. Spec coverage** — every spec section maps to a task:
- §3.1 `projects.json` → Task 1 (registry.ts). ✓
- §3.2 `src/registry.ts` → Task 1. ✓
- §3.3 `src/projects.ts` → Task 3. ✓
- §3.4 `health.ts` per-project flags → Task 5. ✓
- §3.5 `todo-store.ts` unchanged → no task (constraint). ✓
- §3.6 tool actions + panel + slash → Tasks 7 + 8. ✓
- §3.7 `config.ts` `perProjectDefaultMax` → Task 4. ✓
- §3.8 injection unchanged → constraint. ✓
- §4 data flow → Tasks 1/3/5/7/8. ✓
- §5 edge cases → covered in registry/projects tests (Task 1/3). ✓
- §6 testing → Tasks 1/3/4/5/6. ✓
- §7 plan → this plan. ✓
- §8 out of scope → enforced by *not* touching `renderOpenBlock`/`addTodo`. ✓

**2. Placeholder scan** — no TBD/TODO/“implement later”; every code step shows real code. The single explicit skip (PROJECT_STALE clock-mock) is flagged with rationale, not hidden.

**3. Type consistency** — `projectsOverview` (Task 3) consumed by panel (Task 7) + extension (Task 8); `renameProject` return `{ liveRenamed, archivedRenamed, merged, newName }` consistent across registry (Task 1) + extension (Task 8) + panel notify (Task 7); `HealthReport.projects`/`noProject` consistent across health (Task 5) + extension health text (Task 8); `actionsForProject()` returns `rename`/`setmax`/`filter` action ids consistent across panel-data (Task 6) + panel dispatch (Task 7).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-21-project-scope-management.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

> **Note:** pi has no native Task/sub-agent tool (see `~/.pi/agent/AGENTS.md` pi addendum). The in-house `pi-subagents` is a parked TODO (`td-mru4wn19qfj946`). So in pi, the realistic option is **Inline Execution** (executing-plans, batched with checkpoints) — "Subagent-Driven" would require installing the third-party `nicobailon/pi-subagents`, which RECTOR previously declined on trust-surface grounds. Confirm the host before choosing.