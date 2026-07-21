# v0.5.0 Caps Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graduate v0.4.0's advisory per-project `maxOpen` slot into enforcement (block-on-add + project-move), add a global `maxNotesBytes` notes cap (reject at write), and make `renderOpenBlock` cap-aware (lean summary when over `activeMaxOpen`) — the forcing-function half of issue #1.

**Architecture:** Caps are an enforcement layer on top of the existing store — no new data, no migration. A new pure module `src/caps.ts` holds the check primitives (no disk I/O, unit-testable in isolation). `addTodo`/`updateTodo` call them before any mutation (atomic). `renderOpenBlock` reads config + registry to switch to a lean summary when over budget. Config gains `health.maxNotesBytes` (forward-merge, no version bump). Registry unchanged (schema v1). `health` gains a `NOTES_OVER` flag + a `maxId` on `NotesBytes` so the suggestion names the offender.

**Tech Stack:** TypeScript (raw `.ts`, run via tsx at pi runtime — no build step), node:test-style hand-rolled harness (`ok`/`eq` + `mkdtempSync` `TODO_DIR`), node:fs only (zero runtime deps).

## Global Constraints

- Backwards-compatible with v0.4.0 stores: store schema v3, config v1, registry v1 — **no version bumps**.
- Zero runtime deps (node:fs only). 2-space indent. No TODO/FIXME. No AI attribution.
- Circular imports are safe: `caps.ts` imports types/`TodoError` from `todo-store.ts`; `todo-store.ts` imports `caps.ts`. No module touches another's exports at top-level — all usage is inside functions, so by call-time both are fully loaded.
- The cap is on the `open` count only (matches the `PROJECT_OVER` health definition; `in_progress` does **not** count toward `maxOpen`).
- Un-park (`parked→open`) is intentionally **not** cap-checked (reactivation ≠ adding).
- Tests: `node test/<suite>.test.mts` individually; `npm test` runs all. 331 baseline → ~361+ across 12 suites.
- Commits: `feat(scope): …` per task. Branch `feat/caps-release` off `main`. PR → `--merge --delete-branch`.

## File Structure

- **Create** `src/caps.ts` — pure enforcement primitives (`checkNotesCap`, `checkProjectCap`, `overBudgetProjects`).
- **Create** `test/todo-caps.test.mts` — pure-function tests (Task 1) + add/update enforcement (Task 3) + `renderOpenBlock` (Task 4).
- **Modify** `src/config.ts` — add `health.maxNotesBytes` (default 8192) + defensive merge.
- **Modify** `src/todo-store.ts` — `addTodo` + `updateTodo` enforce caps; `renderOpenBlock` cap-aware.
- **Modify** `src/health.ts` — `NotesBytes.maxId`, `NOTES_OVER` flag + suggestion.
- **Modify** `src/panel-data.ts` — `maxNotesBytes` config row.
- **Modify** `src/panel.ts` — `maxNotesBytes` cases in the config getter + setter switches.
- **Modify** `extensions/todo.ts` — promptGuidelines rewrite (caps enforced).
- **Modify** `README.md` — v0.5.0 section + fix stale "capped at 15" / "advisory only" lines.
- **Modify** `package.json` — version `0.5.0`; `npm test` script adds `todo-caps`.

---

## Task 1: Pure caps primitives (`src/caps.ts`) + test suite scaffold

**Files:**
- Create: `src/caps.ts`
- Create: `test/todo-caps.test.mts`
- Modify: `package.json` (the `test` script — add `todo-caps` to the enumeration)

**Interfaces:**
- Consumes: `TodoError`, `Todo` from `./todo-store.ts`; `ProjectRegistry` (type only) from `./registry.ts`.
- Produces: `checkNotesCap(notes: string, maxBytes: number): void`, `checkProjectCap(opts: { project: string; currentOpen: number; maxOpen: number | null }): void`, `overBudgetProjects(liveTodos: Todo[], registry: ProjectRegistry): OverBudgetProject[]`, type `OverBudgetProject { name: string; open: number; maxOpen: number }`.

- [ ] **Step 1: Write `src/caps.ts`**

```ts
// Caps enforcement primitives for armory-todo (v0.5.0). Pure — no disk I/O,
// no config/registry loads. Callers (addTodo/updateTodo/renderOpenBlock) load
// state and pass it in, so these are unit-testable in isolation.
//
// Two caps:
//   - notes  : per-todo byte ceiling (health.maxNotesBytes), hard-reject at write.
//   - project: per-project open-count ceiling (registry maxOpen), hard-reject
//              on add + project-move (only for open/in_progress todos).
// Both throw TodoError BEFORE any store mutation (callers ensure atomicity).
//
// Circular import note: caps.ts imports TodoError/Todo (types) from
// todo-store.ts; todo-store.ts imports the cap functions. Safe — no module
// touches another's exports at top level; all usage is inside functions, so
// both are fully loaded by call-time.

import { TodoError, type Todo } from "./todo-store.ts";
import type { ProjectRegistry } from "./registry.ts";

/** Human-readable byte size for error messages: 512 → "512B", 2048 → "2.0KB". */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** Throw if notes exceeds the byte cap. Byte-length (not char-length): notes
 *  can hold Unicode ("é" = 2 bytes UTF-8). A maxBytes of 0 means "no notes
 *  allowed" (only empty notes pass). Negative maxBytes rejects everything
 *  (treated as a misconfig; config load clamps negative/NaN to the default). */
export function checkNotesCap(notes: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(notes, "utf8");
  if (bytes > maxBytes) {
    throw new TodoError(
      `notes ${formatBytes(bytes)} > max ${formatBytes(maxBytes)} (maxNotesBytes ${maxBytes}) — trim the detail or split into multiple todos`,
    );
  }
}

export interface ProjectCapInput {
  project: string;        // target project name (already trimmed by caller)
  currentOpen: number;     // target's current open count, NOT counting the would-be-added/moved todo
  maxOpen: number | null;  // from the registry entry; null = uncapped
}

/** Throw if adding one more open todo to `project` would exceed its cap.
 *  `maxOpen === null` → no-op (uncapped). The cap is on the `open` count only
 *  (matches the PROJECT_OVER health definition; in_progress does not count). */
export function checkProjectCap({ project, currentOpen, maxOpen }: ProjectCapInput): void {
  if (maxOpen === null) return;
  if (currentOpen + 1 > maxOpen) {
    throw new TodoError(
      `project '${project}' is at maxOpen ${maxOpen} (${currentOpen} open) — close/park one, or raise maxOpen via the /todo panel (Projects tab → Set maxOpen), before adding`,
    );
  }
}

export interface OverBudgetProject { name: string; open: number; maxOpen: number; }

/** Projects whose open count exceeds their explicit maxOpen (maxOpen non-null).
 *  Pure; consumed by renderOpenBlock's over-cap summary. `liveTodos` is the
 *  full live store array. Open is counted here (status === "open"). Sorted by
 *  breach depth (open - maxOpen) desc, then name asc. */
export function overBudgetProjects(liveTodos: Todo[], registry: ProjectRegistry): OverBudgetProject[] {
  const out: OverBudgetProject[] = [];
  for (const entry of registry.projects) {
    if (entry.maxOpen === null) continue;
    const open = liveTodos.filter((t) => t.project === entry.name && t.status === "open").length;
    if (open > entry.maxOpen) out.push({ name: entry.name, open, maxOpen: entry.maxOpen });
  }
  return out.sort((a, b) => (b.open - b.maxOpen) - (a.open - a.maxOpen) || a.name.localeCompare(b.name));
}
```

- [ ] **Step 2: Write `test/todo-caps.test.mts` (pure-function section only — integration tests land in Tasks 3 & 4)**

```ts
// Suite for v0.5.0 caps enforcement (count + notes + injection truncation).
// Run: node test/todo-caps.test.mts
import { mkdtempSync, rmSync } from "node:fs";
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
function throws(name: string, fn: () => void, expectSubstr = ""): void {
  try { fn(); ok(name, false, "(did not throw)"); }
  catch (e) {
    const msg = (e as Error).message;
    ok(name, expectSubstr === "" || msg.includes(expectSubstr), `(msg: ${msg})`);
  }
}
function notThrows(name: string, fn: () => void): void {
  try { fn(); ok(name, true); } catch (e) { ok(name, false, `((unexpected: ${(e as Error).message}))`); }
}

// Pure-function imports (no TODO_DIR needed for this section, but set it so
// later integration sections added in Tasks 3 & 4 can reuse the same tmp).
const tmp = mkdtempSync(join(tmpdir(), "armory-caps-"));
process.env.TODO_DIR = tmp;

const { checkNotesCap, checkProjectCap, overBudgetProjects } = await import("../src/caps.ts");
const { TodoError } = await import("../src/todo-store.ts");

// ===== checkNotesCap =====
notThrows("notes under cap ok", () => checkNotesCap("hello", 16));
throws("notes over cap throws", () => checkNotesCap("x".repeat(100), 50));
throws("notes over cap message has bytes", () => checkNotesCap("x".repeat(100), 50), "maxNotesBytes");
notThrows("notes exactly at cap ok", () => checkNotesCap("ab", 2));
throws("notes cap+1 throws", () => checkNotesCap("abc", 2));
// byte-length not char-length: "é" = 2 bytes UTF-8
notThrows("unicode under byte cap ok", () => checkNotesCap("é", 2));
throws("unicode over byte cap throws", () => checkNotesCap("é", 1));
// 0 = "no notes allowed": empty ok, any content rejected
notThrows("maxBytes 0 + empty notes ok", () => checkNotesCap("", 0));
notThrows("maxBytes 0 + whitespace-only trimmed-empty ok", () => checkNotesCap("", 0));
throws("maxBytes 0 + content throws", () => checkNotesCap("x", 0));
throws("negative maxBytes rejects all", () => checkNotesCap("x", -1));

// ===== checkProjectCap =====
notThrows("uncapped (maxOpen null) ok", () => checkProjectCap({ project: "pi", currentOpen: 100, maxOpen: null }));
notThrows("one-below cap ok (lands at cap, not over)", () => checkProjectCap({ project: "pi", currentOpen: 7, maxOpen: 8 }));
notThrows("zero open under cap ok", () => checkProjectCap({ project: "pi", currentOpen: 0, maxOpen: 1 }));
throws("at-cap add throws (currentOpen == maxOpen)", () => checkProjectCap({ project: "pi", currentOpen: 8, maxOpen: 8 }));
throws("over-cap add throws", () => checkProjectCap({ project: "pi", currentOpen: 12, maxOpen: 8 }));
throws("project cap message has raise hint", () => checkProjectCap({ project: "pi", currentOpen: 8, maxOpen: 8 }), "raise maxOpen");
throws("project cap message has project name", () => checkProjectCap({ project: "getpipher", currentOpen: 8, maxOpen: 8 }), "getpipher");
// maxOpen 0 = no open todos allowed
throws("maxOpen 0 + any add throws", () => checkProjectCap({ project: "pi", currentOpen: 0, maxOpen: 0 }));

// ===== overBudgetProjects =====
const { loadRegistry, saveRegistry } = await import("../src/registry.ts");
import type { Todo } from "../src/todo-store.ts";
const fresh = new Date().toISOString();
const mk = (id: string, project: string, status: Todo["status"]): Todo => ({
  id, title: id, notes: "", project, tags: [], priority: "med", status, source: "",
  createdAt: fresh, updatedAt: fresh, closedAt: null,
});
const liveTodos: Todo[] = [
  mk("a", "pi", "open"), mk("b", "pi", "open"), mk("c", "pi", "open"),
  mk("d", "sip", "open"), mk("e", "sip", "open"),
  mk("f", "sip", "in_progress"),  // in_progress does NOT count toward open
  mk("g", "uncapped", "open"),
];
saveRegistry({ version: 1, updatedAt: "x", projects: [
  { name: "pi", maxOpen: 2, createdAt: "x", updatedAt: "x" },       // 3 open > 2 → over
  { name: "sip", maxOpen: 8, createdAt: "x", updatedAt: "x" },       // 2 open ≤ 8 → ok
  { name: "uncapped", maxOpen: null, createdAt: "x", updatedAt: "x" },
  { name: "empty", maxOpen: 3, createdAt: "x", updatedAt: "x" },     // 0 open → not over
] });
const reg = loadRegistry();
const over = overBudgetProjects(liveTodos, reg);
eq("overBudget count 1 (only pi)", over.length, 1);
eq("overBudget pi name", over[0]!.name, "pi");
eq("overBudget pi open", over[0]!.open, 3);
eq("overBudget pi maxOpen", over[0]!.maxOpen, 2);
// empty registry → none over
eq("overBudget empty registry", overBudgetProjects(liveTodos, { version: 1, updatedAt: "x", projects: [] }).length, 0);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 3: Add `todo-caps` to the `npm test` script in `package.json`**

In `package.json`, the `scripts.test` string enumerates suites. Add `todo-caps` to the loop (order doesn't matter; place it after `panel-data` to keep alphabetical-ish grouping):

```json
"test": "for t in todo-store todo-title-notes todo-archive todo-config todo-migrate todo-health todo-hard-prune todo-auto-prune registry projects panel-data todo-caps; do node test/$t.test.mts || exit 1; done"
```

- [ ] **Step 4: Run the new suite — verify it passes**

Run: `node test/todo-caps.test.mts`
Expected: all pure-function tests PASS (the integration sections are added in Tasks 3 & 4).

- [ ] **Step 5: Run the full suite — verify nothing regressed**

Run: `npm test`
Expected: all 12 suites green (331 prior + the new pure tests).

- [ ] **Step 6: Commit**

```bash
git add src/caps.ts test/todo-caps.test.mts package.json
git commit -m "feat(caps): pure enforcement primitives (checkNotesCap, checkProjectCap, overBudgetProjects)"
```

---

## Task 2: `health.maxNotesBytes` config field

**Files:**
- Modify: `src/config.ts` (the `HealthConfig` interface, `DEFAULT_CONFIG.health`, and the `loadConfig` merge)
- Modify: `test/todo-config.test.mts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `HealthConfig.maxNotesBytes: number` (default `8192`), defensively merged in `loadConfig` (non-number / NaN / negative → default; `0` respected).

- [ ] **Step 1: Add the failing tests to `test/todo-config.test.mts`**

Append (before the final `rmSync`/summary block) — these assert the default + forward-merge + defensive clamp:

```ts
// --- v0.5.0: maxNotesBytes ---
eq("default maxNotesBytes 8192", DEFAULT_CONFIG.health.maxNotesBytes, 8192);
eq("loadConfig maxNotesBytes default", loadConfig().health.maxNotesBytes, 8192);

// forward-merge: an old config (no maxNotesBytes) gets the default
writeFileSync(join(tmp, "todo.config.json"), JSON.stringify({
  version: 1,
  prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] },
  health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8 },
}, null, 2));
const mergedOld = loadConfig();
eq("old config (no maxNotesBytes) → default 8192", mergedOld.health.maxNotesBytes, 8192);

// explicit value respected
saveConfig({ ...mergedOld, health: { ...mergedOld.health, maxNotesBytes: 4096 } });
eq("explicit maxNotesBytes 4096 respected", loadConfig().health.maxNotesBytes, 4096);

// 0 respected (strict no-notes)
saveConfig({ ...mergedOld, health: { ...mergedOld.health, maxNotesBytes: 0 } });
eq("maxNotesBytes 0 respected", loadConfig().health.maxNotesBytes, 0);

// negative → default
writeFileSync(join(tmp, "todo.config.json"), JSON.stringify({
  version: 1,
  prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] },
  health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: -5 },
}, null, 2));
eq("negative maxNotesBytes → default 8192", loadConfig().health.maxNotesBytes, 8192);

// non-number (NaN) → default
writeFileSync(join(tmp, "todo.config.json"), JSON.stringify({
  version: 1,
  prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] },
  health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: "big" },
}, null, 2));
eq("non-number maxNotesBytes → default 8192", loadConfig().health.maxNotesBytes, 8192);
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `node test/todo-config.test.mts`
Expected: FAIL — `DEFAULT_CONFIG.health.maxNotesBytes` is `undefined`, not `8192`.

- [ ] **Step 3: Implement — add the field to `src/config.ts`**

In the `HealthConfig` interface, after `perProjectDefaultMax`:

```ts
  perProjectDefaultMax: number;  // v0.4.0: per-project PROJECT_LARGE threshold (advisory)
  maxNotesBytes: number;        // v0.5.0: per-todo notes byte cap (hard-reject at add/update)
```

In `DEFAULT_CONFIG.health`, after `perProjectDefaultMax: 8,`:

```ts
    perProjectDefaultMax: 8,
    maxNotesBytes: 8192,
```

In `loadConfig`, after the `perProjectDefaultMax` default-fill line:

```ts
    if (health.perProjectDefaultMax === undefined) health.perProjectDefaultMax = DEFAULT_CONFIG.health.perProjectDefaultMax;
    if (health.maxNotesBytes === undefined || typeof health.maxNotesBytes !== "number" || Number.isNaN(health.maxNotesBytes) || health.maxNotesBytes < 0) {
      health.maxNotesBytes = DEFAULT_CONFIG.health.maxNotesBytes;
    }
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `node test/todo-config.test.mts`
Expected: PASS (all, including the new 7 assertions).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/todo-config.test.mts
git commit -m "feat(config): health.maxNotesBytes (default 8192, defensive merge)"
```

---

## Task 3: `addTodo` + `updateTodo` enforce caps

**Files:**
- Modify: `src/todo-store.ts` (imports, `addTodo`, `updateTodo`)
- Modify: `test/todo-caps.test.mts` (append an integration section)

**Interfaces:**
- Consumes: `checkNotesCap`, `checkProjectCap` from `./caps.ts`; `loadConfig` from `./config.ts`; `loadRegistry`, `getProjectEntry` from `./registry.ts`.
- Produces: `addTodo`/`updateTodo` now throw `TodoError` on a cap breach **before** any mutation.

- [ ] **Step 1: Append the failing integration tests to `test/todo-caps.test.mts`**

Insert **before** the final `rmSync`/summary block. These use the real disk store under the temp `TODO_DIR`:

```ts
// ===== addTodo / updateTodo enforcement (integration, temp TODO_DIR) =====
const { addTodo, updateTodo, getTodo } = await import("../src/todo-store.ts");
const { setProjectMaxOpen, saveRegistry, loadRegistry: loadReg } = await import("../src/registry.ts");

// reset store + registry between sub-sections
const { saveStore, loadStore: loadStoreFn } = await import("../src/todo-store.ts");
function resetStore(): void { saveStore({ version: 3, updatedAt: new Date().toISOString(), todos: [] }); saveRegistry({ version: 1, updatedAt: "x", projects: [] }); }
function setCap(project: string, max: number | null): void { const r = loadReg(); setProjectMaxOpen(r, project, max); saveRegistry(r); }

// --- notes cap on add ---
resetStore();
throws("add with oversized notes throws", () => addTodo({ title: "big", notes: "x".repeat(9000) }), "maxNotesBytes");
eq("oversized add did not persist (atomic)", loadStoreFn().todos.length, 0);
notThrows("add with under-cap notes ok", () => addTodo({ title: "ok", notes: "x".repeat(100) }));
// default cap is 8192; exactly 8192 ok, 8193 throws
resetStore();
notThrows("add notes exactly 8192 bytes ok", () => addTodo({ title: "edge", notes: "x".repeat(8192) }));
resetStore();
throws("add notes 8193 bytes throws", () => addTodo({ title: "edge", notes: "x".repeat(8193) }));

// --- notes cap on update (only when notes patch present) ---
resetStore();
const big = addTodo({ title: "seeded big", notes: "y".repeat(9000) }); // grandfathered BEFORE cap? No — add would throw.
// To test grandfathering, seed directly via saveStore bypassing addTodo:
saveStore({ version: 3, updatedAt: new Date().toISOString(), todos: [{ id: "legacy", title: "legacy", notes: "z".repeat(9000), project: "", tags: [], priority: "med", status: "open", source: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), closedAt: null }] });
const legacy = getTodo("legacy");
eq("grandfathered oversize note present", legacy.notes.length, 9000);
// editing TITLE only (no notes patch) must NOT re-check notes → succeeds
notThrows("title edit on grandfathered note ok (no notes re-check)", () => updateTodo("legacy", { title: "new title" }));
eq("title changed", getTodo("legacy").title, "new title");
eq("grandfathered notes intact", getTodo("legacy").notes.length, 9000);
// editing notes (oversize) throws
throws("update notes oversize throws", () => updateTodo("legacy", { notes: "q".repeat(9000) }), "maxNotesBytes");
// notes="" always passes
notThrows("update notes empty clears ok", () => updateTodo("legacy", { notes: "" }));
eq("notes cleared", getTodo("legacy").notes, "");

// --- project cap on add ---
resetStore();
setCap("pi", 2);
notThrows("add #1 to pi (open 0→1) ok", () => addTodo({ title: "p1", project: "pi" }));
notThrows("add #2 to pi (open 1→2, lands at cap) ok", () => addTodo({ title: "p2", project: "pi" }));
throws("add #3 to pi (open 2→3 > maxOpen 2) throws", () => addTodo({ title: "p3", project: "pi" }), "maxOpen");
eq("blocked add not persisted (atomic)", loadStoreFn().todos.filter((t) => t.project === "pi").length, 2);
// uncapped project always ok
notThrows("add to uncapped project ok", () => addTodo({ title: "x", project: "other" }));
// new/unknown project → uncapped (no registry entry) → ok
resetStore();
notThrows("add to unknown project (no cap) ok", () => addTodo({ title: "fresh", project: "newproj" }));

// --- project cap on move (update project) ---
resetStore();
setCap("pi", 2);
setCap("sip", 1);
const m1 = addTodo({ title: "m1", project: "pi" });   // pi open=1
addTodo({ title: "m2", project: "pi" });                // pi open=2 (at cap)
// move an OPEN todo from pi into sip (sip at 0→1, under cap 1) → ok
notThrows("move open todo into under-cap target ok", () => updateTodo(m1.id, { project: "sip" }));
eq("sip now 1 open", loadStoreFn().todos.filter((t) => t.project === "sip" && t.status === "open").length, 1);
// now move another open todo from pi into sip (sip 1→2 > cap 1) → throws
const m2 = loadStoreFn().todos.find((t) => t.project === "pi" && t.status === "open")!;
throws("move open todo into at-cap target throws", () => updateTodo(m2.id, { project: "sip" }), "maxOpen");
// move a PARKED todo into at-cap target → ok (no open impact)
resetStore();
setCap("sip", 1);
addTodo({ title: "occ", project: "sip" });               // sip open=1 (at cap)
const pk = addTodo({ title: "pk", project: "pi" });
updateTodo(pk.id, { status: "parked" });                  // park it (still in pi)
notThrows("move PARKED todo into at-cap target ok (no open impact)", () => updateTodo(pk.id, { project: "sip" }));
eq("parked move persisted to sip", loadStoreFn().todos.find((t) => t.id === pk.id)!.project, "sip");
// same-project "move" (no-op) → ok (no cap check)
resetStore();
setCap("pi", 1);
const s = addTodo({ title: "s", project: "pi" });        // pi at cap 1
notThrows("update same project (no-op) ok", () => updateTodo(s.id, { project: "pi" }));
// un-park (parked→open) into a capped project → NOT blocked (intentional)
resetStore();
setCap("pi", 1);
const u = addTodo({ title: "u", project: "pi" });        // pi at cap 1
updateTodo(u.id, { status: "parked" });                  // pi open=0
addTodo({ title: "u2", project: "pi" });                 // pi open=1 (at cap again)
notThrows("un-park into capped project ok (reactivation not blocked)", () => updateTodo(u.id, { status: "open" }));
eq("un-park persisted (now 2 open, over cap — allowed)", loadStoreFn().todos.filter((t) => t.project === "pi" && t.status === "open").length, 2);
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `node test/todo-caps.test.mts`
Expected: FAIL — the new integration section (`add with oversized notes throws`, `add #3 to pi throws`, etc.) fail because `addTodo`/`updateTodo` don't enforce caps yet.

- [ ] **Step 3: Implement — add imports to `src/todo-store.ts`**

At the top, after the existing imports (`getLivePath, getTodoDir, getLegacyPath` from `./paths.ts` and `migrateIfNeeded, migrateV2ToV3` from `./migrate.ts`), add:

```ts
import { loadConfig } from "./config.ts";
import { loadRegistry, getProjectEntry } from "./registry.ts";
import { checkNotesCap, checkProjectCap } from "./caps.ts";
```

- [ ] **Step 4: Implement — cap checks in `addTodo`**

In `addTodo`, replace the block:

```ts
  const title = normalizeTitle(input.title);
  if (input.priority) assertPriority(input.priority);
  const notes = (input.notes ?? "").trim();
  const store = loadStore();
```

with:

```ts
  const title = normalizeTitle(input.title);
  if (input.priority) assertPriority(input.priority);
  const notes = (input.notes ?? "").trim();
  const store = loadStore();
  // v0.5.0 caps — checked BEFORE any mutation (atomic: nothing is written on breach).
  const config = loadConfig();
  checkNotesCap(notes, config.health.maxNotesBytes);
  const projectTrimmed = (input.project ?? "").trim();
  if (projectTrimmed !== "") {
    const reg = loadRegistry();
    const entry = getProjectEntry(reg, projectTrimmed);
    const maxOpen = entry?.maxOpen ?? null;
    if (maxOpen !== null) {
      const currentOpen = store.todos.filter((t) => t.project === projectTrimmed && t.status === "open").length;
      checkProjectCap({ project: projectTrimmed, currentOpen, maxOpen });
    }
  }
```

- [ ] **Step 5: Implement — cap checks in `updateTodo`**

In `updateTodo`, after `const todo = findOrFail(store, id);` and before `if (patch.title !== undefined) ...`, insert:

```ts
  // v0.5.0 caps — checked BEFORE any mutation (atomic). Notes re-checked only
  // when notes is being written (so a title edit on a grandfathered oversize
  // note isn't trapped). Project cap re-checked only on a real move of an
  // open/in_progress todo (un-park is intentionally NOT re-checked).
  if (patch.notes !== undefined) {
    checkNotesCap(patch.notes.trim(), loadConfig().health.maxNotesBytes);
  }
  if (patch.project !== undefined) {
    const target = patch.project.trim();
    if (target !== todo.project && (todo.status === "open" || todo.status === "in_progress") && target !== "") {
      const reg = loadRegistry();
      const entry = getProjectEntry(reg, target);
      const maxOpen = entry?.maxOpen ?? null;
      if (maxOpen !== null) {
        const currentOpen = store.todos.filter((t) => t.project === target && t.status === "open" && t.id !== todo.id).length;
        checkProjectCap({ project: target, currentOpen, maxOpen });
      }
    }
  }
```

- [ ] **Step 6: Run the tests — verify they pass**

Run: `node test/todo-caps.test.mts`
Expected: PASS (pure section from Task 1 + the new integration section).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all green. (Watch `todo-title-notes` + `todo-store` — they add todos with default projects; `maxOpen` null everywhere so no project cap fires; notes under 8192 so notes cap doesn't fire. Should be unaffected.)

- [ ] **Step 8: Commit**

```bash
git add src/todo-store.ts test/todo-caps.test.mts
git commit -m "feat(store): enforce notes + project caps in addTodo/updateTodo (block-on-add)"
```

---

## Task 4: Cap-aware `renderOpenBlock` (over-budget summary)

**Files:**
- Modify: `src/todo-store.ts` (imports + `renderOpenBlock`)
- Modify: `test/todo-caps.test.mts` (append a `renderOpenBlock` section)

**Interfaces:**
- Consumes: `loadConfig` (already imported in Task 3), `loadRegistry` + `overBudgetProjects` from `./registry.ts` / `./caps.ts`.
- Produces: `renderOpenBlock(max?: number)` — when `actionable > activeMaxOpen`, returns a 3–4 line lean summary instead of the row list; the `max` param overrides `activeMaxOpen` (for tests).

- [ ] **Step 1: Append the failing `renderOpenBlock` tests to `test/todo-caps.test.mts`**

Insert before the final `rmSync`/summary block:

```ts
// ===== renderOpenBlock cap-aware truncation =====
const { renderOpenBlock } = await import("../src/todo-store.ts");
const { loadConfig, saveConfig } = await import("../src/config.ts");

resetStore();
// under cap → row list, no summary, no "… +N more"
saveConfig({ ...loadConfig(), health: { ...loadConfig().health, activeMaxOpen: 15 } });
for (let i = 0; i < 3; i++) addTodo({ title: `t${i}`, project: "pi" });
const under = renderOpenBlock();
ok("under cap: header present", under.startsWith("## Open TODOs (3)"));
ok("under cap: row list (no summary)", under.includes("- [td-"));
ok("under cap: no over-budget marker", !under.includes("over budget"));

// over cap → summary mode
resetStore();
saveConfig({ ...loadConfig(), health: { ...loadConfig().health, activeMaxOpen: 2 } });
setCap("pi", 1);
addTodo({ title: "a", project: "pi" });
addTodo({ title: "b", project: "pi" });   // pi open=2 > maxOpen 1 → over-budget project
addTodo({ title: "c", project: "pi" });   // would exceed pi cap 1? pi at 1 → #2 blocked. So use uncapped for c.
// (c must go to an uncapped project to seed 3 actionable total > activeMaxOpen 2)
resetStore();
saveConfig({ ...loadConfig(), health: { ...loadConfig().health, activeMaxOpen: 2 } });
setCap("pi", 1);
addTodo({ title: "a", project: "pi" });          // pi open=1 (at cap)
addTodo({ title: "b", project: "other" });        // other uncapped
addTodo({ title: "c", project: "other" });        // 3 actionable total > activeMaxOpen 2 → over budget
// make pi over its own cap: bump pi to 2 via direct store seed (add would throw)
saveStore({ version: 3, updatedAt: new Date().toISOString(), todos: [
  ...loadStoreFn().todos,
  { id: "td-extra", title: "extra", notes: "", project: "pi", tags: [], priority: "med", status: "open", source: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), closedAt: null },
] });
const over = renderOpenBlock();
ok("over cap: header has over-budget marker", over.includes("over budget (cap 2)"));
ok("over cap: has actionable count line", over.includes("open+in_progress"));
ok("over cap: over-budget projects listed (pi 2/1)", over.includes("pi 2/1"));
ok("over cap: has pointer line", over.includes("todo list") || over.includes("/todo"));
ok("over cap: no row list (no - [td-)", !over.includes("- [td-"));

// over global cap but NO project over its own cap → summary without over-budget line
resetStore();
saveConfig({ ...loadConfig(), health: { ...loadConfig().health, activeMaxOpen: 1 } });
addTodo({ title: "a", project: "pi" });   // pi uncapped (no setCap)
addTodo({ title: "b", project: "pi" });   // 2 actionable > activeMaxOpen 1, but pi has no maxOpen
const overNoProj = renderOpenBlock();
ok("over global, no per-project breach: over-budget header", overNoProj.includes("over budget (cap 1)"));
ok("over global, no per-project breach: no 'over-budget:' line", !overNoProj.includes("over-budget:"));

// custom max param overrides activeMaxOpen
resetStore();
saveConfig({ ...loadConfig(), health: { ...loadConfig().health, activeMaxOpen: 50 } });
for (let i = 0; i < 5; i++) addTodo({ title: `t${i}` });
const viaParam = renderOpenBlock(3);   // 5 actionable > 3 → summary
ok("custom max param triggers summary", viaParam.includes("over budget (cap 3)"));
const viaParamUnder = renderOpenBlock(10);  // 5 ≤ 10 → row list
ok("custom max param under → row list", viaParamUnder.includes("- [td-"));

// empty store → unchanged
resetStore();
eq("empty store render", renderOpenBlock(), "## Open TODOs\n(none — no pending cross-session TODOs)\n");
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `node test/todo-caps.test.mts`
Expected: FAIL — the over-cap cases still render the row list + "… +N more" (current behavior), not the summary.

- [ ] **Step 3: Implement — update imports in `src/todo-store.ts`**

Extend the `caps.ts` import to include `overBudgetProjects` and the type, and add the registry import (already added in Task 3). Change the import line from Task 3:

```ts
import { checkNotesCap, checkProjectCap } from "./caps.ts";
```

to:

```ts
import { checkNotesCap, checkProjectCap, overBudgetProjects } from "./caps.ts";
```

(`loadRegistry` is already imported in Task 3.)

- [ ] **Step 4: Implement — rewrite `renderOpenBlock` in `src/todo-store.ts`**

Replace the entire existing `renderOpenBlock` function with:

```ts
/** Compact markdown summary of open + in_progress TODOs for system-prompt
 *  injection. v0.5.0: cap-aware — when actionable > activeMaxOpen (from
 *  config, or the `max` override), switches to a lean summary (counts +
 *  over-budget projects + pointer) instead of the row list, keeping the
 *  prompt bounded when bloated. Under cap → the familiar row list (capped
 *  at activeMaxOpen rows). */
export function renderOpenBlock(max?: number): string {
  const todos = listTodos(); // actionable set, sorted
  if (todos.length === 0) return "## Open TODOs\n(none — no pending cross-session TODOs)\n";
  let cap: number;
  try { cap = max ?? loadConfig().health.activeMaxOpen; } catch { cap = 15; }
  if (todos.length <= cap) {
    const shown = todos.slice(0, cap);
    const lines = shown.map((t) => {
      const tag = t.project ? ` (${t.project})` : "";
      const pin = t.status === "in_progress" ? " ⏵" : "";
      const dot = t.notes.trim() ? " •" : "";
      return `- [${t.id}] (${t.priority})${pin}${dot} ${t.title}${tag}`;
    });
    return `## Open TODOs (${todos.length})\n${lines.join("\n")}\n`;
  }
  // over budget → lean summary (the anti-bloat path)
  let over: { name: string; open: number; maxOpen: number }[] = [];
  try {
    const reg = loadRegistry();
    over = overBudgetProjects(loadStore().todos, reg);
  } catch {
    // fail-open: a bad registry shouldn't break injection
  }
  const projects = new Set(todos.map((t) => t.project.trim()).filter(Boolean));
  const lines = [
    `## Open TODOs (${todos.length}) — ⚠ over budget (cap ${cap})`,
    `${todos.length} open+in_progress across ${projects.size} project${projects.size === 1 ? "" : "s"}`,
  ];
  if (over.length > 0) {
    lines.push(`over-budget: ${over.map((p) => `${p.name} ${p.open}/${p.maxOpen}`).join(", ")}`);
  }
  lines.push("run `todo list` or `/todo` to see the full list");
  return lines.join("\n") + "\n";
}
```

- [ ] **Step 5: Run the tests — verify they pass**

Run: `node test/todo-caps.test.mts`
Expected: PASS (pure + add/update + renderOpenBlock sections).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green. (The `todo-title-notes` suite calls `renderOpenBlock` with few todos — under cap, so it renders the row list as before. The `todo-auto-prune`/`todo-store` suites likewise stay under 15. No regressions expected.)

- [ ] **Step 7: Commit**

```bash
git add src/todo-store.ts test/todo-caps.test.mts
git commit -m "feat(store): cap-aware renderOpenBlock — lean summary when over activeMaxOpen"
```

---

## Task 5: `health` `NOTES_OVER` flag + `NotesBytes.maxId`

**Files:**
- Modify: `src/health.ts` (the `NotesBytes` interface, the `notesBytes` computation, the `HealthFlag` union, the flags + suggestions blocks)
- Modify: `test/todo-health.test.mts`

**Interfaces:**
- Consumes: `config.health.maxNotesBytes` (from Task 2).
- Produces: `NotesBytes.maxId: string | null`; `"NOTES_OVER"` in `HealthFlag`; a suggestion naming the offender id.

- [ ] **Step 1: Add the failing tests to `test/todo-health.test.mts`**

The existing health suite seeds a v2 store via `saveStore({ version: 2, ... text: ... })` and relies on the v2→v3 migration. For the NOTES_OVER test we need a todo with notes > maxNotesBytes. Append (before the final summary) a self-contained sub-section that sets its own store + config:

```ts
// ===== v0.5.0: NOTES_OVER flag + maxId =====
import { saveConfig as saveCfg } from "../src/config.ts";
const tmp2 = mkdtempSync(join(tmpdir(), "armory-notes-"));
process.env.TODO_DIR = tmp2;
process.env.TODO_STORE_PATH = join(tmp2, "todo.json");
saveCfg({ version: 1, prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] }, health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: 100 } });
const bigNotes = "z".repeat(500);
const smallNotes = "y".repeat(20);
saveStore({ version: 3, updatedAt: fresh, todos: [
  { id: "td-big", title: "big note todo", notes: bigNotes, project: "pi", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
  { id: "td-small", title: "small note todo", notes: smallNotes, project: "pi", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
] });
const rep2 = healthReport();
ok("NOTES_OVER flag present when max note > cap", rep2.flags.includes("NOTES_OVER"));
eq("notesBytes.max is the big note size", rep2.notesBytes.max, 500);
eq("notesBytes.maxId is the big todo", rep2.notesBytes.maxId, "td-big");
ok("NOTES_OVER suggestion names the offender id", rep2.suggestions.some((s) => s.includes("td-big") && s.includes("trim via todo update")));

// under cap → no NOTES_OVER
saveCfg({ version: 1, prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] }, health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: 8192 } });
const rep3 = healthReport();
ok("no NOTES_OVER when under cap", !rep3.flags.includes("NOTES_OVER"));
// maxId still tracked even when under cap (points to the biggest, which is td-big 500B)
eq("maxId tracked under cap (biggest note)", rep3.notesBytes.maxId, "td-big");

rmSync(tmp2, { recursive: true, force: true });
// restore the original suite's TODO_DIR for any trailing assertions
process.env.TODO_DIR = tmp;
process.env.TODO_STORE_PATH = join(tmp, "todo.json");
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `node test/todo-health.test.mts`
Expected: FAIL — `rep2.notesBytes.maxId` is `undefined`; `NOTES_OVER` not in flags.

- [ ] **Step 3: Implement — extend `NotesBytes` + the computation in `src/health.ts`**

Change the `NotesBytes` interface:

```ts
export interface NotesBytes {
  total: number;
  max: number;
  maxId: string | null;   // v0.5.0: id of the todo with the largest notes (null if no todos)
  avg: number;
}
```

Replace the `notesBytes` computation block:

```ts
  // notes bytes across active + parked (archived excluded — sealed history).
  const apTodos = [...openTodos, ...ipTodos, ...parkedTodos];
  const notesSizes = apTodos.map((t) => Buffer.byteLength(t.notes, "utf8"));
  const notesBytes: NotesBytes = {
    total: notesSizes.reduce((a, b) => a + b, 0),
    max: notesSizes.length ? Math.max(...notesSizes) : 0,
    avg: notesSizes.length ? Math.round(notesSizes.reduce((a, b) => a + b, 0) / notesSizes.length) : 0,
  };
```

with:

```ts
  // notes bytes across active + parked (archived excluded — sealed history).
  // v0.5.0: track the worst-offender id so the NOTES_OVER suggestion is actionable.
  const apTodos = [...openTodos, ...ipTodos, ...parkedTodos];
  let maxId: string | null = null;
  let maxSize = 0;
  let totalBytes = 0;
  for (const t of apTodos) {
    const s = Buffer.byteLength(t.notes, "utf8");
    totalBytes += s;
    if (s > maxSize) { maxSize = s; maxId = t.id; }
  }
  const notesBytes: NotesBytes = {
    total: totalBytes,
    max: maxSize,
    maxId: apTodos.length ? maxId : null,
    avg: apTodos.length ? Math.round(totalBytes / apTodos.length) : 0,
  };
```

- [ ] **Step 4: Implement — add `NOTES_OVER` to the flag union + the flag/suggestion**

In the `HealthFlag` union, add `NOTES_OVER`:

```ts
export type HealthFlag =
  | "ACTIVE_LARGE" | "ACTIVE_STALE"
  | "PARKED_LARGE" | "PARKED_STALE"
  | "ARCHIVE_LARGE" | "ARCHIVE_OLD"
  | "NOTES_OVER"
  | "PROJECT_OVER" | "PROJECT_TYPO" | "PROJECT_LARGE" | "PROJECT_STALE";
```

In the flags block, after the archive flags (`if (archiveOld > 0) flags.push("ARCHIVE_OLD");`), add:

```ts
  if (notesBytes.max > h.maxNotesBytes) flags.push("NOTES_OVER");
```

In the suggestions block, after the `archiveOld` suggestion, add:

```ts
  if (notesBytes.max > h.maxNotesBytes) {
    const id = notesBytes.maxId ?? "<id>";
    suggestions.push(`notes: largest note ${notesBytes.max}B > cap ${h.maxNotesBytes}B (on ${id}) → trim via todo update ${id} notes:…`);
  }
```

- [ ] **Step 5: Run the tests — verify they pass**

Run: `node test/todo-health.test.mts`
Expected: PASS (all prior + the new NOTES_OVER assertions).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/health.ts test/todo-health.test.mts
git commit -m "feat(health): NOTES_OVER flag + NotesBytes.maxId (offender-aware suggestion)"
```

---

## Task 6: `maxNotesBytes` config row in the panel

**Files:**
- Modify: `src/panel-data.ts` (`configToSettingItems`)
- Modify: `src/panel.ts` (the `configValueDisplay` + `applyConfigChange` switches)
- Modify: `test/panel-data.test.mts`

**Interfaces:**
- Consumes: `TodoConfig.health.maxNotesBytes` (from Task 2).
- Produces: a new editable Config row "Notes max bytes"; the panel getter/setter handle the `maxNotesBytes` id.

- [ ] **Step 1: Add the failing test to `test/panel-data.test.mts`**

Append (before the final summary):

```ts
// v0.5.0: maxNotesBytes config row
const { DEFAULT_CONFIG: DCFG } = await import("../src/config.ts");
const cfg = DCFG;
const items = configToSettingItems(cfg);
const row = items.find((i) => i.id === "maxNotesBytes");
ok("maxNotesBytes row present", row !== undefined);
ok("maxNotesBytes row label", row?.label === "Notes max bytes");
eq("maxNotesBytes row current value", row?.currentValue, "8192");
ok("maxNotesBytes row has value options", Array.isArray(row?.values) && row!.values.length > 0);
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `node test/panel-data.test.mts`
Expected: FAIL — no `maxNotesBytes` row.

- [ ] **Step 3: Implement — add the row to `src/panel-data.ts`**

In `configToSettingItems`, after the `archiveOldDays` row (the last existing row), append:

```ts
    { id: "archiveOldDays", label: "Archive old (days)", currentValue: String(cfg.health.archiveOldDays), values: ["90", "180", "365"], description: "Bloat flag when archive items older than this." },
    { id: "maxNotesBytes", label: "Notes max bytes", currentValue: String(cfg.health.maxNotesBytes), values: ["2048", "4096", "8192", "16384", "32768"], description: "Hard reject at add/update when notes exceeds this (bytes). 0 = no notes allowed." },
```

- [ ] **Step 4: Implement — handle the new id in `src/panel.ts`**

In `configValueDisplay`, add a case (after `archiveOldDays`):

```ts
      case "archiveOldDays": return String(c.health.archiveOldDays);
      case "maxNotesBytes": return String(c.health.maxNotesBytes);
```

In `applyConfigChange`, add a case (after `archiveOldDays`):

```ts
      case "archiveOldDays": this.config.health.archiveOldDays = n; break;
      case "maxNotesBytes": this.config.health.maxNotesBytes = n; break;
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `node test/panel-data.test.mts`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/panel-data.ts src/panel.ts test/panel-data.test.mts
git commit -m "feat(panel): editable maxNotesBytes config row"
```

---

## Task 7: Extension surfaces — promptGuidelines + health render

**Files:**
- Modify: `extensions/todo.ts` (the `promptGuidelines` array — the `add`/`update` line + the `project_rename` line)
- Test: no new automated test (the extension is not unit-tested per the existing convention — verified via `node --check` + the autonomous tmux QA gate). The `health` action's `NOTES_OVER` flag flows through the generic `flags:` line automatically (no special rendering needed).

**Interfaces:**
- Consumes: the enforced caps from Tasks 2–4; `NOTES_OVER` from Task 5.
- Produces: accurate agent guidance (caps enforced, not "lands in v0.5.0"); `health` output reflects `NOTES_OVER` via the existing generic flag list + the new suggestion.

- [ ] **Step 1: Update the `add`/`update` promptGuidelines line**

In `extensions/todo.ts`, the `promptGuidelines` array, replace:

```ts
      "Use todo (action:'add', title, notes?, project?, tags?, priority?, source?) when the user says 'put this in our TODO'. title max 120 chars (one-line summary); put long detail in notes.",
```

with:

```ts
      "Use todo (action:'add', title, notes?, project?, tags?, priority?, source?) when the user says 'put this in our TODO'. title max 120 chars (one-line summary); put long detail in notes (capped at health.maxNotesBytes, default 8KB — oversize is rejected at write). Adds are BLOCKED if the target project is at its per-project maxOpen cap (the slot you set via the Projects tab); close/park one or raise maxOpen first.",
```

- [ ] **Step 2: Update the `project_rename` promptGuidelines line**

Replace:

```ts
      "Use todo (action:'project_rename', oldName, newName) to rename or merge a project (rewrites live + archive + registry). Use it to fix typo'd project strings (e.g. getpither → getpipher). Rename onto an existing name merges (consolidates the old project into the new). Advisory maxOpen caps are NOT enforced in v0.4.0 — they only drive a health flag; enforcement lands in v0.5.0.",
```

with:

```ts
      "Use todo (action:'project_rename', oldName, newName) to rename or merge a project (rewrites live + archive + registry). Use it to fix typo'd project strings (e.g. getpither → getpipher). Rename onto an existing name merges (consolidates the old project into the new). Per-project maxOpen caps are ENFORCED (block-on-add); they also drive a PROJECT_OVER health flag when breached.",
```

- [ ] **Step 3: Verify syntax**

Run: `node --check extensions/todo.ts`
Expected: no output (syntax OK).

- [ ] **Step 4: Run the full suite (unchanged — no test changes here)**

Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add extensions/todo.ts
git commit -m "feat(extension): promptGuidelines reflect enforced caps (v0.5.0)"
```

---

## Task 8: README upgrade notes + version bump + final verification

**Files:**
- Modify: `README.md` (a new "Caps enforcement (v0.5.0)" section + fixes to stale lines)
- Modify: `package.json` (version `0.5.0`)

- [ ] **Step 1: Fix the stale "capped at 15" line in README**

In the "How it works → Auto-inject" section, replace:

```md
- **Auto-inject** — on every `before_agent_start`, a compact `## Open TODOs (N)` block (titles + ids, capped at 15, sorted by priority) is appended to the system prompt, so the agent starts every turn already aware of pending work. Only `open` + `in_progress` are injected — `parked` and archived todos are excluded (the lifecycle-box boundary). Mutations refresh it on the next turn.
```

with:

```md
- **Auto-inject** — on every `before_agent_start`, a compact `## Open TODOs (N)` block (titles + ids, sorted by priority) is appended to the system prompt, so the agent starts every turn already aware of pending work. The block is **cap-aware** (v0.5.0): under `health.activeMaxOpen` (default 15) it lists the rows; **over** the cap it collapses to a lean summary (counts + over-budget projects + a `todo list` pointer) so the prompt stays bounded when the store bloats. Only `open` + `in_progress` are injected — `parked` and archived todos are excluded (the lifecycle-box boundary). Mutations refresh it on the next turn.
```

- [ ] **Step 2: Fix the stale "Advisory only in v0.4.0" line**

In the "Project-scope management (v0.4.0)" section, replace:

```md
**Advisory only in v0.4.0** — `maxOpen` drives a `health` flag, it does **not** block `add` (enforcement graduates in v0.5.0, alongside count + notes caps + over-cap injection truncation).
```

with:

```md
**Advisory in v0.4.0 → enforced in v0.5.0** — `maxOpen` now blocks `add` (and project-move) when a project is at its cap. See the [Caps enforcement (v0.5.0)](#caps-enforcement-v050) section below.
```

- [ ] **Step 3: Fix the stale "Known issues" line**

In "Known issues", replace:

```md
- **No caps enforcement yet (count / notes / injection).** v0.4.0's `maxOpen` slot is advisory only (drives a `health` flag); block-on-add for count + notes caps + over-cap injection truncation land in v0.5.0. Until then, `health` reports counts + notes-bytes as read-only diagnostics.
```

with:

```md
- **Caps enforcement shipped in v0.5.0.** Per-project `maxOpen` blocks `add`/move; `health.maxNotesBytes` (default 8KB) rejects oversize notes at write; the auto-injected block collapses to a lean summary over `activeMaxOpen`. See [Caps enforcement (v0.5.0)](#caps-enforcement-v050) above.
```

- [ ] **Step 4: Add the new "Caps enforcement (v0.5.0)" section**

Insert a new section immediately after the "Project-scope management (v0.4.0)" section (before "Interactive panel (SPEC-3)"):

```md
## Caps enforcement (v0.5.0)

Three caps keep the store (and its auto-injected prompt block) from bloating silently — the forcing-function half of [issue #1](https://github.com/getpither/armory-todo/issues/1):

1. **Count cap (per-project `maxOpen`, enforced).** A project's `maxOpen` slot (set via the Projects tab → Set maxOpen, or `setProjectMaxOpen`) **blocks `add`** when the project is at its cap, and **blocks a project-move** of an `open`/`in_progress` todo into a capped project. The cap is on the `open` count (matches the `PROJECT_OVER` health flag); `in_progress` doesn't count. Un-park (`parked→open`) is intentionally **not** blocked — reactivating deferred work isn't adding new work. The block message tells you how to raise/clear the cap. `maxOpen: null` (default) = uncapped.

2. **Notes cap (`health.maxNotesBytes`, default 8192 bytes, enforced).** Oversize notes are rejected at `add`/`update` (only when `notes` is being written — a title edit on a grandfathered oversize note isn't trapped). Byte-length, not char-length (notes can hold Unicode). Existing oversize notes are grandfathered; `health` surfaces the worst offender via the `NOTES_OVER` flag + an actionable `todo update <id> notes:…` suggestion.

3. **Over-cap injection truncation.** When actionable > `health.activeMaxOpen` (default 15), the auto-injected `## Open TODOs (N)` block collapses to a ~4-line summary (total + project span + over-budget projects + a `todo list` pointer) instead of the row list. Under the cap → the familiar row list. `activeMaxOpen` itself stays **advisory** (it drives the `ACTIVE_LARGE` flag and the truncation trigger; it is not a hard global block).

**Backwards-compat:** zero migration (store v3, config v1, registry v1 unchanged in shape). Oversize notes grandfathered. The `maxOpen` advisory→enforced graduation is a documented behavior change for any v0.4.0 user who set a slot (the block message tells them how to raise/clear).
```

- [ ] **Step 5: Bump the version in `package.json`**

Change `"version": "0.4.0"` to `"version": "0.5.0"`.

- [ ] **Step 6: Run the full suite + syntax checks**

Run: `npm test`
Expected: all 12 suites green (~361+ total).

Run: `node --check extensions/todo.ts && node --check src/panel.ts && node --check src/todo-store.ts && node --check src/health.ts && node --check src/config.ts && node --check src/caps.ts && node --check src/panel-data.ts`
Expected: no output (all syntax OK).

- [ ] **Step 7: Commit**

```bash
git add README.md package.json
git commit -m "docs(v0.5.0): caps enforcement section + version bump"
```

- [ ] **Step 8: Final verification — push branch + open PR**

```bash
git push -u origin feat/caps-release
gh pr create --base main --head feat/caps-release --title "v0.5.0: caps release (Feature B enforcement)" --body-file - <<'EOF'
Graduates v0.4.0's advisory `maxOpen` slot into enforcement + adds a notes cap + cap-aware injection truncation — the forcing-function half of issue #1.

- **Count cap** — per-project `maxOpen` blocks `add` + project-move (open/in_progress only; un-park not blocked).
- **Notes cap** — `health.maxNotesBytes` (default 8192B) rejects oversize notes at write; grandfathered existing; `NOTES_OVER` health flag + offender-id suggestion.
- **Injection truncation** — `renderOpenBlock` collapses to a lean summary (counts + over-budget projects + pointer) when actionable > `activeMaxOpen`.

Zero migration (store v3 / config v1 / registry v1 unchanged in shape). 331 → ~361+ tests across 12 suites (new `todo-caps`). Spec: `docs/superpowers/specs/2026-07-21-caps-release-design.md`.
EOF
```

Expected: PR opened. Then proceed to the self-review + autonomous tmux QA gate (per the spec §10 flow) before merge → tag `v0.5.0` → CI auto-publish.

---

## Self-Review (run after writing the plan — fix inline, don't re-review)

**1. Spec coverage:**
- §4.1 caps.ts (checkNotesCap, checkProjectCap, overBudgetProjects) → Task 1 ✓
- §4.2 config maxNotesBytes → Task 2 ✓
- §4.3 addTodo/updateTodo enforcement → Task 3 ✓
- §4.3 renderOpenBlock cap-aware + §4.4 summary shape → Task 4 ✓
- §4.5 health NOTES_OVER + maxId → Task 5 ✓
- §4.6 panel-data maxNotesBytes row → Task 6 ✓
- §4.7 extensions promptGuidelines + health render → Task 7 ✓
- §9 README upgrade notes + version bump → Task 8 ✓
- §6 error handling (atomic, fail-open registry) → covered in Task 3/4 implementations ✓
- §7 testing (new + extended suites) → Tasks 1, 2, 3, 4, 5, 6 ✓

**2. Placeholder scan:** no TBD/TODO/"implement later"/"add appropriate" — all steps contain actual code. ✓

**3. Type consistency:**
- `checkNotesCap(notes: string, maxBytes: number)` — Task 1 def, Task 3 call ✓
- `checkProjectCap({ project, currentOpen, maxOpen })` — Task 1 def, Task 3 call ✓
- `overBudgetProjects(liveTodos, registry): { name, open, maxOpen }[]` — Task 1 def, Task 4 use ✓
- `NotesBytes.maxId: string | null` — Task 5 def + test ✓
- `HealthFlag` includes `NOTES_OVER` — Task 5 ✓
- `HealthConfig.maxNotesBytes: number` — Task 2 ✓
- panel getter/setter id `maxNotesBytes` matches the panel-data row id — Tasks 6 ✓

No gaps. Plan is complete.