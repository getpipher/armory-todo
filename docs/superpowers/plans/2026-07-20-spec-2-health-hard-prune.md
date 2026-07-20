# SPEC-2: Self-Awareness — Health Diagnostics + Hard-Prune

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the self-awareness layer to armory-todo — a `health` action that detects bloat across active/parked/archive boxes and suggests cleanup, plus `prune --hard` (the only irreversible action, gated by a tool-level `confirm: true` flag + prompt-level "always ask first" + `ctx.ui.confirm` on the slash path).

**Architecture:** Two new focused modules: `src/health.ts` (pure-read bloat report from live store + archive + config heuristics) and `src/hard-prune.ts` (the only deletion path, `confirm`-gated, can target any box). The extension gains `health` + `prune --hard` tool actions, `/todo health` + `/todo prune --hard` slash subcommands, a session-start bloat nudge, and prompt guidelines instructing the agent to surface health + wait for user confirmation before hard-prune.

**Tech Stack:** Same as SPEC-1 — TypeScript, Node.js (`node:fs`/`node:os`/`node:path`), zero runtime deps. Tests: `node test/*.test.mts`. pi extension API for the extension layer.

**Design doc:** `docs/superpowers/specs/2026-07-20-lifecycle-boxes-prune-design.md` §8 (health report + heuristics) + §9 (hard-prune gate) + §11 (session_start nudge).

## Global Constraints

- **Zero runtime dependencies** — same as SPEC-1.
- **`prune --hard` is the ONLY irreversible action.** It must refuse without `confirm: true` (tool-level structural gate). The prompt guidelines instruct the agent to always surface the `health` report + proposed command + wait for explicit user "yes" before passing `confirm: true`.
- **`health` is a pure read** — no side effects, no writes.
- **Heuristic thresholds come from `todo.config.json`** (the `health` block added in SPEC-1). Missing config → defaults (already handled by `loadConfig`).
- **2-space indent**, no TODO/FIXME in delivered code.
- Tests run via `node test/todo-health.test.mts` + `node test/todo-hard-prune.test.mts` (new) alongside the existing 4 suites.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `src/health.ts` | `healthReport()` — pure-read bloat diagnostics across active/parked/archive, driven by config heuristics. Returns structured report + flags + suggestions. | Create |
| `src/hard-prune.ts` | `hardPrune(opts)` — the only deletion path. `confirm: true` required (refuses otherwise). Targets `archive`/`active`/`parked` boxes with optional `olderThan`/`project`/`tag` filters. | Create |
| `extensions/todo.ts` | Add `health` + `prune --hard` tool actions; extend `ACTIONS`; add `confirm`/`box`/`olderThan` params; update prompt guidelines; session_start bloat nudge; `/todo health` + `/todo prune --hard` slash subcommands. | Modify |
| `test/todo-health.test.mts` | healthReport: correct flags + counts for constructed scenarios (active stale, parked stale, archive large/old); thresholds from config. | Create |
| `test/todo-hard-prune.test.mts` | hardPrune: refuses without confirm; deletes with confirm; targets boxes + filters; irreversible (gone after). | Create |

---

## Task 1: `healthReport` — bloat diagnostics (pure read)

**Files:**
- Create: `src/health.ts`
- Create: `test/todo-health.test.mts`

**Interfaces:**
- Consumes: `loadStore` + `listTodos` from `src/todo-store.ts`, `loadArchive` from `src/archive.ts`, `loadConfig` from `src/config.ts`.
- Produces: `HealthReport`, `healthReport(): HealthReport`.

- [ ] **Step 1: Write the failing test**

Create `test/todo-health.test.mts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const tmp = mkdtempSync(join(tmpdir(), "armory-health-"));
process.env.TODO_DIR = tmp;
process.env.TODO_STORE_PATH = join(tmp, "todo.json");

const { healthReport } = await import("../src/health.ts");
const { saveStore, loadStore } = await import("../src/todo-store.ts");
const { saveArchive, loadArchive } = await import("../src/archive.ts");
import type { Todo } from "../src/todo-store.ts";

const now = Date.now();
const stale = new Date(now - 45 * 86400_000).toISOString();   // 45 days ago (> 30d threshold)
const fresh = new Date(now - 5 * 86400_000).toISOString();    // 5 days ago
const parkedStale = new Date(now - 70 * 86400_000).toISOString(); // 70 days (> 60d)
const archOld = new Date(now - 200 * 86400_000).toISOString();    // 200 days (> 180d)

// Seed a live store: 16 open (1 stale), 3 in_progress, 12 parked (1 stale), 2 done (fresh-closed)
const liveTodos: Todo[] = [];
for (let i = 0; i < 16; i++) liveTodos.push({ id: `td-open-${i}`, text: `open ${i}`, project: i < 5 ? "pi" : "", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: i === 0 ? stale : fresh, closedAt: null });
for (let i = 0; i < 3; i++) liveTodos.push({ id: `td-ip-${i}`, text: `ip ${i}`, project: "", tags: [], priority: "high", status: "in_progress", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null });
for (let i = 0; i < 12; i++) liveTodos.push({ id: `td-park-${i}`, text: `parked ${i}`, project: "", tags: [], priority: "low", status: "parked", source: "", createdAt: fresh, updatedAt: i === 0 ? parkedStale : fresh, closedAt: null });
for (let i = 0; i < 2; i++) liveTodos.push({ id: `td-done-${i}`, text: `done ${i}`, project: "", tags: [], priority: "med", status: "done", source: "", createdAt: fresh, updatedAt: fresh, closedAt: fresh });
saveStore({ version: 2, updatedAt: fresh, todos: liveTodos });

// Seed an archive: 210 items (10 older than 180d)
const archTodos: Todo[] = [];
for (let i = 0; i < 210; i++) archTodos.push({ id: `td-arch-${i}`, text: `arch ${i}`, project: i < 50 ? "nuntius" : "", tags: [], priority: "med", status: i % 2 === 0 ? "done" : "cancelled", source: "", createdAt: fresh, updatedAt: fresh, closedAt: i < 10 ? archOld : fresh });
saveArchive({ version: 2, updatedAt: fresh, todos: archTodos });

const report = healthReport();

// active: 16 open + 3 in_progress = 19 (> 15 threshold → ACTIVE_LARGE); 1 stale (> 30d → ACTIVE_STALE)
eq("active open count", report.active.open, 16);
eq("active in_progress count", report.active.in_progress, 3);
eq("active stale_30d", report.active.stale_30d, 1);
ok("ACTIVE_LARGE flag", report.flags.includes("ACTIVE_LARGE"));
ok("ACTIVE_STALE flag", report.flags.includes("ACTIVE_STALE"));

// parked: 12 (> 10 → PARKED_LARGE); 1 stale (> 60d → PARKED_STALE)
eq("parked count", report.parked.count, 12);
eq("parked stale_60d", report.parked.stale_60d, 1);
ok("PARKED_LARGE flag", report.flags.includes("PARKED_LARGE"));
ok("PARKED_STALE flag", report.flags.includes("PARKED_STALE"));

// archive: 210 (> 200 → ARCHIVE_LARGE); 10 older than 180d → ARCHIVE_OLD
eq("archive count", report.archive.count, 210);
eq("archive older_180d", report.archive.older_180d, 10);
ok("ARCHIVE_LARGE flag", report.flags.includes("ARCHIVE_LARGE"));
ok("ARCHIVE_OLD flag", report.flags.includes("ARCHIVE_OLD"));

// suggestions present + actionable
ok("has suggestions", report.suggestions.length >= 0);
ok("archive suggestion mentions hard-prune", report.suggestions.some((s) => s.includes("hard-prune") || s.includes("prune --hard")));
ok("active suggestion mentions park or close", report.suggestions.some((s) => s.includes("park") || s.includes("close")));

// --- clean store → no flags ---
saveStore({ version: 2, updatedAt: fresh, todos: [] });
saveArchive({ version: 2, updatedAt: fresh, todos: [] });
const clean = healthReport();
eq("clean active open", clean.active.open, 0);
eq("clean flags empty", clean.flags.length, 0);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-health.test.mts`
Expected: FAIL — `Cannot find module '../src/health.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/health.ts`:

```ts
// Bloat diagnostics for armory-todo — a pure-read report across all three
// lifecycle boxes (active / parked / archive), driven by the heuristics in
// todo.config.json. No side effects. The agent surfaces this + suggestions,
// then waits for user confirmation before any `prune --hard` (SPEC-2).

import { loadStore } from "./todo-store.ts";
import { loadArchive } from "./archive.ts";
import { loadConfig } from "./config.ts";
import type { Todo } from "./todo-store.ts";

export interface ActiveHealth {
  open: number;
  in_progress: number;
  stale_30d: number;       // open todos with updatedAt older than activeStaleDays
}

export interface ParkedHealth {
  count: number;
  stale_60d: number;       // parked with updatedAt older than parkedStaleDays
}

export interface ArchiveHealth {
  count: number;
  older_180d: number;      // closedAt older than archiveOldDays
}

export type HealthFlag =
  | "ACTIVE_LARGE" | "ACTIVE_STALE"
  | "PARKED_LARGE" | "PARKED_STALE"
  | "ARCHIVE_LARGE" | "ARCHIVE_OLD";

export interface HealthReport {
  active: ActiveHealth;
  parked: ParkedHealth;
  archive: ArchiveHealth;
  flags: HealthFlag[];
  suggestions: string[];
}

function daysAgo(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86400_000;
}

export function healthReport(): HealthReport {
  const config = loadConfig();
  const h = config.health;
  const live = loadStore();
  const archive = loadArchive();

  const openTodos = live.todos.filter((t) => t.status === "open");
  const ipTodos = live.todos.filter((t) => t.status === "in_progress");
  const parkedTodos = live.todos.filter((t) => t.status === "parked");
  const actionable = [...openTodos, ...ipTodos];

  const activeStale = openTodos.filter((t) => daysAgo(t.updatedAt) > h.activeStaleDays).length;
  const parkedStale = parkedTodos.filter((t) => daysAgo(t.updatedAt) > h.parkedStaleDays).length;
  const archiveOld = archive.todos.filter((t) => t.closedAt && daysAgo(t.closedAt) > h.archiveOldDays).length;

  const active: ActiveHealth = {
    open: openTodos.length,
    in_progress: ipTodos.length,
    stale_30d: activeStale,
  };
  const parked: ParkedHealth = { count: parkedTodos.length, stale_60d: parkedStale };
  const arch: ArchiveHealth = { count: archive.todos.length, older_180d: archiveOld };

  const flags: HealthFlag[] = [];
  if (actionable.length > h.activeMaxOpen) flags.push("ACTIVE_LARGE");
  if (activeStale > 0) flags.push("ACTIVE_STALE");
  if (parkedTodos.length > h.parkedMax) flags.push("PARKED_LARGE");
  if (parkedStale > 0) flags.push("PARKED_STALE");
  if (archive.todos.length > h.archiveMax) flags.push("ARCHIVE_LARGE");
  if (archiveOld > 0) flags.push("ARCHIVE_OLD");

  const suggestions: string[] = [];
  if (archiveOld > 0) suggestions.push(`archive: ${archiveOld} items older than ${h.archiveOldDays}d → consider \`prune --hard --box archive --older-than ${h.archiveOldDays} --confirm\``);
  if (activeStale > 0) suggestions.push(`active: ${activeStale} open TODOs untouched for ${h.activeStaleDays}d → park or close them`);
  if (parkedStale > 0) suggestions.push(`parked: ${parkedStale} parked > ${h.parkedStaleDays}d → restore or hard-prune`);
  if (actionable.length > h.activeMaxOpen) suggestions.push(`active: ${actionable.length} open+in_progress (max ${h.activeMaxOpen}) → close or park some before adding more`);

  return { active, parked, archive: arch, flags, suggestions };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-health.test.mts`
Expected: PASS (all assertions)

- [ ] **Step 5: Commit**

```bash
git add src/health.ts test/todo-health.test.mts
git commit -m "feat(health): bloat diagnostics — pure-read report across active/parked/archive"
```

---

## Task 2: `hardPrune` — the only irreversible deletion (confirm-gated)

**Files:**
- Create: `src/hard-prune.ts`
- Create: `test/todo-hard-prune.test.mts`

**Interfaces:**
- Consumes: `loadStore`/`saveStore` from `src/todo-store.ts`, `loadArchive`/`saveArchive` from `src/archive.ts`.
- Produces: `HardPruneInput`, `HardPruneResult`, `hardPrune(opts: HardPruneInput): HardPruneResult`. Refuses (returns `{ refused: true, ... }`) unless `confirm: true`.

- [ ] **Step 1: Write the failing test**

Create `test/todo-hard-prune.test.mts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const tmp = mkdtempSync(join(tmpdir(), "armory-hardprune-"));
process.env.TODO_DIR = tmp;
process.env.TODO_STORE_PATH = join(tmp, "todo.json");

const { hardPrune } = await import("../src/hard-prune.ts");
const { loadStore, saveStore } = await import("../src/todo-store.ts");
const { loadArchive, saveArchive } = await import("../src/archive.ts");
import type { Todo } from "../src/todo-store.ts";

const now = Date.now();
const oldDate = new Date(now - 200 * 86400_000).toISOString();
const fresh = new Date().toISOString();

// Seed: archive with 5 old (closedAt 200d ago) + 5 fresh; live with 2 parked + 1 open
const archTodos: Todo[] = [];
for (let i = 0; i < 5; i++) archTodos.push({ id: `td-arch-old-${i}`, text: `old ${i}`, project: i < 2 ? "nuntius" : "", tags: [], priority: "med", status: "done", source: "", createdAt: oldDate, updatedAt: oldDate, closedAt: oldDate });
for (let i = 0; i < 5; i++) archTodos.push({ id: `td-arch-fresh-${i}`, text: `fresh ${i}`, project: "", tags: [], priority: "med", status: "done", source: "", createdAt: fresh, updatedAt: fresh, closedAt: fresh });
saveArchive({ version: 2, updatedAt: fresh, todos: archTodos });

const liveTodos: Todo[] = [
  { id: "td-park-1", text: "parked one", project: "pi", tags: [], priority: "low", status: "parked", source: "", createdAt: fresh, updatedAt: oldDate, closedAt: null },
  { id: "td-park-2", text: "parked two", project: "", tags: [], priority: "low", status: "parked", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
  { id: "td-open-1", text: "open one", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
];
saveStore({ version: 2, updatedAt: fresh, todos: liveTodos });

// --- refuses without confirm ---
const refused = hardPrune({ box: "archive", olderThan: 180 });
ok("refuses without confirm", refused.refused === true);
eq("refused deleted count", refused.deleted, 0);
eq("archive untouched after refuse", loadArchive().todos.length, 10);

// --- deletes with confirm: archive, olderThan 180 → 5 old deleted ---
const result = hardPrune({ box: "archive", olderThan: 180, confirm: true });
ok("not refused with confirm", !result.refused);
eq("deleted 5 old archive items", result.deleted, 5);
eq("archive now has 5", loadArchive().todos.length, 5);
ok("only fresh remain", loadArchive().todos.every((t) => t.id.includes("fresh")));

// --- deletes with project filter ---
saveArchive({ version: 2, updatedAt: fresh, todos: archTodos }); // reset
const byProject = hardPrune({ box: "archive", olderThan: 180, project: "nuntius", confirm: true });
eq("project filter deleted 2", byProject.deleted, 2);

// --- targets parked box (live store) ---
saveStore({ version: 2, updatedAt: fresh, todos: liveTodos });
const parkedPrune = hardPrune({ box: "parked", olderThan: 60, confirm: true });
eq("parked prune deleted 1 (the stale one)", parkedPrune.deleted, 1);
const liveAfter = loadStore();
ok("fresh parked survived", liveAfter.todos.some((t) => t.id === "td-park-2"));
ok("stale parked gone", !liveAfter.todos.some((t) => t.id === "td-park-1"));
ok("open survived parked-prune", liveAfter.todos.some((t) => t.id === "td-open-1"));

// --- targets active box (open + in_progress only; parked excluded) ---
saveStore({ version: 2, updatedAt: fresh, todos: [
  { id: "td-stale-open", text: "stale open", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: oldDate, closedAt: null },
  { id: "td-fresh-open", text: "fresh open", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
  { id: "td-parked-survives", text: "parked", project: "", tags: [], priority: "low", status: "parked", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
] });
const activePrune = hardPrune({ box: "active", olderThan: 60, confirm: true });
eq("active prune deleted 1 (stale open)", activePrune.deleted, 1);
const liveAfterActive = loadStore();
ok("fresh open survived", liveAfterActive.todos.some((t) => t.id === "td-fresh-open"));
ok("parked survived active-prune", liveAfterActive.todos.some((t) => t.id === "td-parked-survives"));
ok("stale open gone", !liveAfterActive.todos.some((t) => t.id === "td-stale-open"));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-hard-prune.test.mts`
Expected: FAIL — `Cannot find module '../src/hard-prune.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/hard-prune.ts`:

```ts
// The ONLY irreversible deletion path in armory-todo. Everything else is
// reversible (park = status flip, prune = archive move, restore = move back).
// hardPrune permanently deletes todos from the targeted box.
//
// Structural gate: refuses to execute unless `confirm: true` is passed. Even
// if the agent hallucinates intent, the tool demands the flag. The prompt
// guidelines (extensions/todo.ts) instruct the agent to always surface the
// `health` report + the exact proposed command and wait for an explicit user
// "yes" before passing confirm. The slash path uses ctx.ui.confirm.

import { loadStore, saveStore } from "./todo-store.ts";
import { loadArchive, saveArchive } from "./archive.ts";
import type { Todo } from "./todo-store.ts";

export type HardPruneBox = "archive" | "active" | "parked";

export interface HardPruneInput {
  confirm: boolean;            // REQUIRED — must be true to execute
  box?: HardPruneBox;          // default: "archive"
  olderThan?: number;          // days; filters by updatedAt (active/parked) or closedAt (archive)
  project?: string;
  tag?: string;
}

export interface HardPruneResult {
  refused: boolean;
  deleted: number;
  ids: string[];
  message: string;
}

function daysAgo(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86400_000;
}

/**
 * Permanently delete todos from a box. The only irreversible action.
 * Returns `{ refused: true, deleted: 0, ... }` unless `confirm: true`.
 */
export function hardPrune(opts: HardPruneInput): HardPruneResult {
  if (!opts.confirm) {
    return {
      refused: true,
      deleted: 0,
      ids: [],
      message: "Refused: pass confirm:true to execute hard-prune (this permanently deletes).",
    };
  }
  const box: HardPruneBox = opts.box ?? "archive";
  const cutoff = opts.olderThan ? Date.now() - opts.olderThan * 86400_000 : null;

  const matches = (t: Todo): boolean => {
    if (opts.project && t.project !== opts.project) return false;
    if (opts.tag && !t.tags.includes(opts.tag)) return false;
    if (cutoff !== null) {
      const dateField = box === "archive" ? (t.closedAt ?? t.updatedAt) : t.updatedAt;
      if (Date.parse(dateField) > cutoff) return false;
    }
    return true;
  };

  if (box === "archive") {
    const archive = loadArchive();
    const kept: Todo[] = [];
    const deleted: Todo[] = [];
    for (const t of archive.todos) (matches(t) ? deleted : kept).push(t);
    if (deleted.length === 0) return { refused: false, deleted: 0, ids: [], message: "No archived todos matched the criteria." };
    archive.todos = kept;
    saveArchive(archive);
    return { refused: false, deleted: deleted.length, ids: deleted.map((t) => t.id), message: `Permanently deleted ${deleted.length} archived todo${deleted.length === 1 ? "" : "s"}.` };
  }

  // active or parked box → live store
  const live = loadStore();
  const targetStatuses = box === "parked" ? ["parked"] : ["open", "in_progress"];
  const kept: Todo[] = [];
  const deleted: Todo[] = [];
  for (const t of live.todos) {
    if (targetStatuses.includes(t.status) && matches(t)) {
      deleted.push(t);
    } else {
      kept.push(t);
    }
  }
  if (deleted.length === 0) return { refused: false, deleted: 0, ids: [], message: `No ${box} todos matched the criteria.` };
  live.todos = kept;
  saveStore(live);
  return { refused: false, deleted: deleted.length, ids: deleted.map((t) => t.id), message: `Permanently deleted ${deleted.length} ${box} todo${deleted.length === 1 ? "" : "s"}.` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-hard-prune.test.mts`
Expected: PASS (all assertions)

- [ ] **Step 5: Commit**

```bash
git add src/hard-prune.ts test/todo-hard-prune.test.mts
git commit -m "feat(hard-prune): the only irreversible deletion — confirm-gated, targets any box"
```

---

## Task 3: Extension tool — `health` + `prune --hard` actions + prompt guidelines

**Files:**
- Modify: `extensions/todo.ts`

**Interfaces:**
- Consumes: `healthReport` from `src/health.ts`, `hardPrune` from `src/hard-prune.ts`.
- Produces: `todo` tool gains `health` + `prune --hard` (via `action: "health"` and `action: "prune"` with `hard: true`); new params `hard`, `confirm`, `box`, `olderThan`.

- [ ] **Step 1: No standalone test (extension layer — manual gate).** The store logic is covered by Tasks 1–2. Verify via `node --check extensions/todo.ts` after edits.

- [ ] **Step 2: (syntax check is the gate)**

- [ ] **Step 3: Write minimal implementation**

In `extensions/todo.ts`, make these edits:

1. Add imports:

```ts
import { pruneTodos, restoreTodo, listArchived, archiveSummary } from "../src/archive";
import { healthReport } from "../src/health";
import { hardPrune } from "../src/hard-prune";
```

2. Extend `ACTIONS`:

```ts
const ACTIONS = ["list", "add", "update", "complete", "delete", "clear", "park", "prune", "restore", "health"] as const;
```

3. Extend the tool `parameters` — add `hard`, `confirm`, `box`, `olderThan`:

```ts
      // prune options
      ageDays: Type.Optional(Type.Number({ description: "prune: closedAt older than this many days (default from config)" })),
      all: Type.Optional(Type.Boolean({ description: "prune: ignore age, move all done/cancelled" })),
      // hard-prune options (SPEC-2)
      hard: Type.Optional(Type.Boolean({ description: "prune: if true, execute a HARD prune (permanent deletion). Requires confirm:true. The only irreversible action." })),
      confirm: Type.Optional(Type.Boolean({ description: "hard-prune: must be true to execute. Always surface the health report + proposed command and wait for explicit user confirmation first." })),
      box: Type.Optional(StringEnum(["archive", "active", "parked"] as const, { description: "hard-prune: which box to target (default archive)" })),
      olderThan: Type.Optional(Type.Number({ description: "hard-prune: delete items older than this many days (by closedAt for archive, updatedAt for active/parked)" })),
```

4. Update the tool `description` + `promptGuidelines`:

```ts
    description:
      "Global cross-session TODO store (persists across ALL pi sessions, not just this one). " +
      "Use when the user says 'put this in our TODO', 'show me the TODO', 'mark <id> done', 'park <id>', 'prune', 'restore <id>', 'how is my todo hygiene?', etc. " +
      "Open TODOs are auto-injected each turn; parked todos are NOT injected (deferred/someday). " +
      "Done/cancelled todos are moved to an archive by `prune` (reversible via `restore`). " +
      "`prune --hard` (hard:true, confirm:true) is the ONLY irreversible action — always run `health` first, surface the report + proposed command, and wait for explicit user confirmation. " +
      "Never put secrets in a TODO — the text reaches the model provider.",
    promptSnippet: "Read/update the global cross-session TODO list (active / parked / archive) + bloat health",
    promptGuidelines: [
      "Use todo (action:'list') when the user asks 'show me the TODO' / 'what's pending'.",
      "Use todo (action:'add', text, project?, tags?, priority?, source?) when the user says 'put this in our TODO'.",
      "Use todo (action:'complete', id) to mark a TODO done; (action:'delete', id) to cancel it.",
      "Use todo (action:'park', id) to defer a TODO (not injected, recoverable); (action:'update', id, status:'open') to un-park.",
      "Use todo (action:'prune') to move done/cancelled todos to the archive (reversible); (action:'prune', all:true) to prune all regardless of age.",
      "Use todo (action:'restore', id) to bring an archived TODO back as open.",
      "Use todo (action:'list', archived:true) to query the archive — bare call returns a summary; add a filter (project/text/since) for specific items.",
      "Use todo (action:'health') to check bloat across all boxes — returns counts + flags + suggestions. Run this when the user asks about hygiene/bloat or before any hard-prune.",
      "Use todo (action:'prune', hard:true, confirm:true, box?, olderThan?) for PERMANENT deletion — the only irreversible action. ALWAYS: run `health` first, show the user the report + the exact proposed command, and wait for an explicit 'yes' before passing confirm:true. Never hard-prune without explicit user confirmation.",
    ],
```

5. Update the `execute` switch — extend the `prune` case + add a `health` case. Replace the existing `prune` case:

```ts
          case "prune": {
            if (params.hard) {
              const res = hardPrune({
                confirm: params.confirm === true,
                box: params.box,
                olderThan: params.olderThan,
                project: params.projectFilter,
                tag: params.tagFilter,
              });
              return { content: [{ type: "text" as const, text: res.message + (res.refused ? "" : ` Deleted: ${res.ids.join(", ") || "(none)"}`) }] };
            }
            const res = pruneTodos({ ageDays: params.ageDays, all: params.all });
            return { content: [{ type: "text" as const, text: `Pruned ${res.moved} todo${res.moved === 1 ? "" : "s"} to archive: ${res.ids.join(", ") || "(none)"}` }] };
          }
          case "health": {
            const report = healthReport();
            const lines = [
              `## TODO Health Report`,
              `active:  ${report.active.open} open + ${report.active.in_progress} in_progress (${report.active.stale_30d} stale >${"30"}d)`,
              `parked:  ${report.parked.count} (${report.parked.stale_60d} stale >${"60"}d)`,
              `archive: ${report.archive.count} (${report.archive.older_180d} older >${"180"}d)`,
              report.flags.length ? `flags: ${report.flags.join(", ")}` : "flags: (none — healthy)",
              ...report.suggestions.map((s) => `  → ${s}`),
            ];
            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          }
```

- [ ] **Step 4: Verify syntax**

Run: `node --check extensions/todo.ts`
Expected: exit 0 (syntax valid)

- [ ] **Step 5: Commit**

```bash
git add extensions/todo.ts
git commit -m "feat(ext): health + prune --hard tool actions + prompt guidelines (always-ask-first)"
```

---

## Task 4: Extension slash — `/todo health` + `/todo prune --hard` (ctx.ui.confirm gate)

**Files:**
- Modify: `extensions/todo.ts` (slash command handler)

- [ ] **Step 1: (manual gate — slash commands need a live TUI)**

- [ ] **Step 2: (skipped)**

- [ ] **Step 3: Write minimal implementation**

In `extensions/todo.ts`, add `health` + `hard` subcommand routing to the slash handler. Insert before the `// default: list open` fallback:

```ts
        if (sub === "health") {
          const report = healthReport();
          const lines = [
            `TODO Health:`,
            `  active:  ${report.active.open} open + ${report.active.in_progress} in_progress (${report.active.stale_30d} stale)`,
            `  parked:  ${report.parked.count} (${report.parked.stale_60d} stale)`,
            `  archive: ${report.archive.count} (${report.archive.older_180d} old)`,
            report.flags.length ? `  ⚠ ${report.flags.join(", ")}` : "  ✅ healthy",
            ...report.suggestions.map((s) => `  → ${s}`),
          ];
          if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
```

And extend the existing `prune` slash case to handle `--hard` with a `ctx.ui.confirm` gate:

```ts
        if (sub === "prune") {
          const isHard = rest.includes("--hard");
          if (isHard) {
            // Parse remaining flags: --box <box> --older-than <N> --project <p>
            const boxIdx = rest.indexOf("--box");
            const olderIdx = rest.indexOf("--older-than");
            const projIdx = rest.indexOf("--project");
            const box = boxIdx >= 0 ? rest[boxIdx + 1] : undefined;
            const olderThan = olderIdx >= 0 ? Number(rest[olderIdx + 1]) : undefined;
            const project = projIdx >= 0 ? rest[projIdx + 1] : undefined;
            const preview = hardPrune({ confirm: false, box: box as any, olderThan, project });
            if (ctx.hasUI) {
              const yes = await ctx.ui.confirm(
                `HARD PRUNE (permanent deletion)\n${preview.message}\nBox: ${box ?? "archive"}${olderThan ? `, older than ${olderThan}d` : ""}${project ? `, project: ${project}` : ""}\n\nProceed?`,
              );
              if (!yes) { ctx.ui.notify("Hard-prune cancelled.", "info"); return; }
            }
            const res = hardPrune({ confirm: true, box: box as any, olderThan, project });
            if (ctx.hasUI) ctx.ui.notify(res.message + ` Deleted: ${res.ids.join(", ") || "(none)"}`, res.refused ? "warning" : "info");
            return;
          }
          const all = rest.includes("--all");
          const res = pruneTodos({ all });
          if (ctx.hasUI) ctx.ui.notify(`Pruned ${res.moved} todo${res.moved === 1 ? "" : "s"} to archive: ${res.ids.join(", ") || "(none)"}`, "info");
          return;
        }
```

Update the command `description` to advertise the new subcommands:

```ts
    description:
      "Global cross-session TODO list. " +
      "/todo · /todo all · /todo add <text> · /todo done <id> · /todo rm <id> · " +
      "/todo park <id> · /todo restore <id> · /todo prune [--all|--hard --box <b> --older-than <d>] · " +
      "/todo archive [project:X|text:Y] · /todo health · /todo clean · /todo path",
```

- [ ] **Step 4: Verify syntax**

Run: `node --check extensions/todo.ts`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add extensions/todo.ts
git commit -m "feat(ext): /todo health + /todo prune --hard slash subcommands (ctx.ui.confirm gate)"
```

---

## Task 5: session_start bloat nudge

**Files:**
- Modify: `extensions/todo.ts` (the `session_start` handler)

- [ ] **Step 1: (manual gate)**

- [ ] **Step 2: (skipped)**

- [ ] **Step 3: Write minimal implementation**

In `extensions/todo.ts`, upgrade the `session_start` handler to surface bloat flags:

```ts
  pi.on("session_start", async (_event, ctx) => {
    try {
      const open = listTodos();
      let msg = `armory-todo: ${open.length} open TODO${open.length === 1 ? "" : "s"}`;
      try {
        const report = healthReport();
        if (report.flags.length > 0) {
          msg += ` — ⚠ ${report.flags.length} bloat signal${report.flags.length === 1 ? "" : "s"} (run /todo health)`;
        }
      } catch {
        // health check optional — don't crash the session notify
      }
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
    } catch {
      // store unavailable — never crash the session
    }
  });
```

- [ ] **Step 4: Verify syntax**

Run: `node --check extensions/todo.ts`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add extensions/todo.ts
git commit -m "feat(ext): session_start bloat nudge — surface health flags on startup"
```

---

## Task 6: README + AGENTS.md update

**Files:**
- Modify: `README.md`, `AGENTS.md`

- [ ] **Step 3: Write the updates**

In `README.md`, update the tool table + slash section to include `health` + `prune --hard`. Add a "Self-awareness (SPEC-2)" subsection under Lifecycle boxes:

```markdown
## Self-awareness: health + hard-prune (SPEC-2)

**`health`** reports bloat across all three boxes — counts, stale items, and
actionable suggestions (e.g. "archive: 41 items older than 180d → consider
`prune --hard --box archive --older-than 180 --confirm`"). On `session_start`,
if any bloat flags are detected, the startup notify appends a `⚠ N bloat
signals` nudge.

**`prune --hard`** is the **only irreversible action** — it permanently deletes
todos. It's gated three ways:
1. **Tool-level:** `confirm: true` is required in the tool call; without it the
   action refuses with a clear message.
2. **Prompt-level:** the agent is instructed to always run `health` first,
   surface the report + the exact proposed command, and wait for an explicit
   user "yes" before passing `confirm: true`.
3. **Slash-level:** `/todo prune --hard` prompts an interactive `ctx.ui.confirm`
   yes/no dialog before executing.

Everything else in armory-todo is reversible. `prune --hard` is the one
irreversible escape hatch, always user-confirmed.
```

Update the tool table to add:
```
| `health` | (none) | bloat report across active/parked/archive + flags + suggestions |
| `prune` (hard) | `hard:true`, `confirm:true`, `box?`, `olderThan?`, `project?`, `tag?` | PERMANENT deletion — the only irreversible action |
```

Update `AGENTS.md` Notes to mention SPEC-2 is done (health + hard-prune shipped).

- [ ] **Step 4: Run all tests**

Run: `for t in todo-store todo-archive todo-config todo-migrate todo-health todo-hard-prune; do node test/$t.test.mts || exit 1; done`
Expected: all 6 suites PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs(spec-2): health + hard-prune — self-awareness layer"
```

---

## Final verification (before declaring SPEC-2 done)

- [ ] All 6 test suites pass.
- [ ] No `TODO`/`FIXME`/`HACK` in delivered code.
- [ ] `node --check extensions/todo.ts` passes.
- [ ] `hardPrune` refuses without `confirm: true` (verified by test).
- [ ] Manual gate (real pi session, deferred to the post-SPEC-3 QA): `/todo health` shows the report; `/todo prune --hard --box archive --older-than 180` prompts a confirm dialog; refusing cancels; accepting deletes.

## Out of scope for SPEC-2

- **Interactive `/todo` TUI panel** → SPEC-3 (next).
- **`title` + `notes` split** → Workstream B.
- **Preventive caps-on-add + project registry** → Workstream C.