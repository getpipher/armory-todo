# Workstream B — title + notes schema split (v0.3.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `text` field into `title` (≤120 chars, injected) + `notes` (any length, not injected), with a v2→v3 migration, a new `get` action, and a hard title cap — so the 1.8KB ZeroClaw blob stops being injected verbatim every turn.

**Architecture:** Schema break in the pure store layer (`src/todo-store.ts`) — `Todo` gains `title`+`notes`, drops `text`; `Store.version` → 3. `loadStore` runs a v2→v3 migration (curated for 2 known ids + first-line fallback) and persists once. The extension tool gains a `get` action and rewrites `add`/`update` to use `title`/`notes`; `list` searches title+notes and shows a `•` notes-indicator. Auto-injection renders `title` only. The panel list shows `title`; a new read-only detail view shows `notes`; inline Edit edits `title` only. Health gains a notes-bytes diagnostic.

**Tech Stack:** TypeScript (raw `.ts`, no build step, run via tsx at pi runtime), node:test-style custom harness (ok/eq with temp `TODO_DIR`), typebox for tool schemas, `@earendil-works/pi-tui` for the panel. Zero runtime deps (node:fs only).

## Global Constraints

- **Zero runtime deps** (node:fs only). 2-space indent. No TODO/FIXME. No AI attribution in commits.
- **`TITLE_MAX = 120`** chars — hard reject at `add`/`update` (not a soft truncate). Defined in `src/todo-store.ts` (normalizeTitle) and `src/migrate.ts` (splitTextFallback) — keep both in sync (commented).
- **Store version: 3.** v2→v3 migration runs in `loadStore` when `parsed.version === 2`; persists once via `saveStore`. The v1→v2 *file-move* migration (`migrateIfNeeded`, guarded to default `TODO_DIR`) stays as-is. The v2→v3 *schema* migration needs **no env guard** (only touches the live path, temp in tests).
- **Curated migration** for ids `td-mrt3zp9fcnug3p` + `td-mrt4e1qi9td6jz` (hand-written title+notes, verbatim from the spec §6.3). Fallback for any other v2 todo: first line → title (capped 120, word-boundary, full original first line preserved into notes if truncated), remainder → notes.
- **No `text` field on `Todo`** after Task 1. The `list`/archive `text` *filter param* stays (means "search query", matches title OR notes).
- **No append-only `log`** (YAGNI). **No notes caps** (Workstream C). **No in-panel multi-line notes edit** (pi-tui nested-UI blocker — tracked as known deferred issue).
- **Tests:** baseline 151 across 7 suites → target ~175+. New suite `test/todo-title-notes.test.mts`. Extend the 6 existing suites. Run via `npm test` (loops `node test/<suite>.test.mts`). Syntax-check extension/panel with `node --check`.
- **Branch:** `feat/title-notes-split` off `main`. Commits: `feat(scope): ...` per task. PR → `--merge --delete-branch`. No GitLab mirror (getpipher). Tag `v0.3.0` after RECTOR QA.

**Spec:** `docs/superpowers/specs/2026-07-21-title-notes-split-design.md`

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/migrate.ts` | Add `splitTextFallback` (Task 1); add `CURATED_V2_TO_V3` + `migrateV2ToV3` (Task 2). Keep `migrateIfNeeded`. | 1, 2 |
| `src/todo-store.ts` | Schema break: `Todo`+`title`+`notes` (drop `text`), `Store.version:3`, `TITLE_MAX`+`normalizeTitle`, `addTodo`/`updateTodo`/`getTodo`, `listTodos` filter (title\|notes), `renderOpenBlock` (title+dot), `loadStore` v2→v3 wiring. | 1, 2 |
| `src/archive.ts` | `ArchiveStore.version:3`; `loadArchive` runs v2→v3 via `migrateV2ToV3`; `listArchived` text filter → title\|notes. | 3 |
| `extensions/todo.ts` | `ACTIONS`+`get`; input schema (`title`,`notes`,`text`→search); `fmt` (title+dot); add/update/get/complete/delete/park/restore/clear/prune output → title; prompt guidelines rewrite; `/todo add <title>`. | 4 |
| `src/panel-data.ts` | `todoToItem` → title+dot, delete truncation; `actionsForTodo` "Edit text"→"Edit title". | 5 |
| `src/panel.ts` | Detail view (read-only title+notes); Edit = title only. | 5 |
| `src/health.ts` | `notesBytes` in report (total/max/avg, active+parked). | 6 |
| `test/todo-title-notes.test.mts` | NEW — cap, add/update/get, fallback, list filter, renderOpenBlock. | 1 |
| `test/todo-store.test.mts` | Update `text`→`title` calls; add reference cap cases. | 1 |
| `test/todo-migrate.test.mts` | v2→v3 curated + fallback + persist-once + works under TODO_DIR. | 2 |
| `test/todo-archive.test.mts` | listArchived title+dot; v2 archive → v3 on load. | 3 |
| `test/panel-data.test.mts` | todoToItem title+dot; Todo literals → title/notes. | 5 |
| `test/todo-health.test.mts` | notesBytes line; active+parked only. | 6 |
| `test/todo-config.test.mts`, `test/todo-hard-prune.test.mts` | Update `addTodo({text})`→`{title}` call sites + Todo literals. | 1 |
| `README.md`, `AGENTS.md`, `package.json` | Schema docs, known issues, version 0.3.0. | 7 |

---

## Task 1: Store schema break + core CRUD + inline v2→v3 derivation

**Files:**
- Modify: `src/todo-store.ts` (full rewrite of `Todo`/`Store`/`AddInput`/`UpdateInput`/`addTodo`/`updateTodo`/`listTodos`/`renderOpenBlock`/`loadStore`/`emptyStore`; add `getTodo`/`normalizeTitle`/`TITLE_MAX`)
- Modify: `src/migrate.ts` (add `splitTextFallback` + `truncateWordBoundary`)
- Create: `test/todo-title-notes.test.mts`
- Modify: `test/todo-store.test.mts`, `test/todo-archive.test.mts`, `test/todo-config.test.mts`, `test/todo-hard-prune.test.mts`, `test/todo-health.test.mts`, `test/panel-data.test.mts` (update `addTodo({text})`→`{title}` + Todo literals `text`→`title`/`notes`)

**Interfaces:**
- Consumes: `splitTextFallback(text: string): { title: string; notes: string }` from `src/migrate.ts` (new in this task).
- Produces: `Todo { title, notes }`, `Store { version: 3 }`, `AddInput { title, notes? }`, `UpdateInput { title?, notes? }`, `getTodo(id)`, `TITLE_MAX = 120`. Later tasks rely on these exact names.

- [ ] **Step 1: Add `splitTextFallback` to `src/migrate.ts`**

Append after the existing `migrateIfNeeded` function (keep `migrateIfNeeded` unchanged):

```ts
// v2 → v3 schema migration helpers. splitTextFallback is used by loadStore's
// inline derivation (Task 1) and by migrateV2ToV3 (Task 2, with the curated
// map). TITLE_MAX here must match the constant in todo-store.ts.
const TITLE_MAX = 120;

/** Truncate at the last word boundary ≤ TITLE_MAX (hard cut if none). No "…"
 *  suffix — the cap is a hard rule, not a display truncation. */
function truncateWordBoundary(s: string): string {
  if (s.length <= TITLE_MAX) return s;
  const slice = s.slice(0, TITLE_MAX);
  const sp = slice.lastIndexOf(" ");
  return sp > 0 ? slice.slice(0, sp) : slice;
}

/** Derive { title, notes } from a v2 `text` string (the fallback for any v2
 *  todo not in the curated map). Deterministic + idempotent. */
export function splitTextFallback(text: string): { title: string; notes: string } {
  const raw = (text ?? "").trim();
  if (!raw) return { title: "(untitled)", notes: "" };
  const nl = raw.indexOf("\n");
  if (nl < 0) {
    if (raw.length <= TITLE_MAX) return { title: raw, notes: "" };
    return { title: truncateWordBoundary(raw), notes: raw };
  }
  const firstLine = raw.slice(0, nl).trim();
  const rest = raw.slice(nl + 1).trim();
  if (firstLine.length <= TITLE_MAX) return { title: firstLine, notes: rest };
  return { title: truncateWordBoundary(firstLine), notes: `${firstLine}\n${rest}` };
}
```

- [ ] **Step 2: Verify it parses**

Run: `node --check src/migrate.ts`
Expected: no output (success).

- [ ] **Step 3: Rewrite the schema + core CRUD in `src/todo-store.ts`**

Replace the `Todo` interface:

```ts
export interface Todo {
  id: string;
  title: string;       // ≤120 chars, non-empty, trimmed
  notes: string;       // any length, may be ""
  project: string;
  tags: string[];
  priority: Priority;
  status: Status;
  source: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
```

Replace `Store` + `emptyStore`:

```ts
export interface Store {
  version: 3;
  updatedAt: string;
  todos: Todo[];
}

function emptyStore(): Store {
  return { version: 3, updatedAt: now(), todos: [] };
}
```

Replace `AddInput` + `UpdateInput`:

```ts
export interface AddInput {
  title: string;
  notes?: string;
  project?: string;
  tags?: string[];
  priority?: Priority;
  source?: string;
}

export interface UpdateInput {
  title?: string;
  notes?: string;
  project?: string;
  tags?: string[];
  priority?: Priority;
  status?: Status;
}
```

Add `TITLE_MAX` + `normalizeTitle` near the other helpers (after `genId`):

```ts
const TITLE_MAX = 120;  // must match the constant in migrate.ts

function normalizeTitle(raw: string): string {
  const t = raw.trim();
  if (!t) throw new TodoError("title is required");
  if (t.length > TITLE_MAX) {
    throw new TodoError(`title must be ≤${TITLE_MAX} chars (got ${t.length}); move detail into notes`);
  }
  return t;
}
```

Update the `import` from `./migrate.ts` to also pull `splitTextFallback`:

```ts
import { migrateIfNeeded, splitTextFallback } from "./migrate.ts";
```

Replace `loadStore`'s version-handling block. The current block is:

```ts
    if (parsed.version !== 2) {
      // v1 → v2: accept it (the migration moved the file), just bump the version in memory.
      // The data shape is otherwise identical; parked status is new but old todos won't have it.
      parsed.version = 2;
    }
    return parsed;
```

Replace with:

```ts
    if (parsed.version === 2) {
      // v2 → v3: derive title/notes from each todo's text (inline fallback).
      // Task 2 replaces this with migrateV2ToV3 (curated map + persist-once).
      parsed = {
        version: 3,
        updatedAt: parsed.updatedAt,
        todos: parsed.todos.map((t: any) => {
          const { title, notes } = splitTextFallback(t.text ?? "");
          const { text: _drop, ...rest } = t;
          return { ...rest, title, notes } as Todo;
        }),
      };
    } else if (parsed.version !== 3) {
      throw new Error("invalid store shape");
    }
    return parsed;
```

Replace `addTodo`:

```ts
export function addTodo(input: AddInput): Todo {
  const title = normalizeTitle(input.title);
  if (input.priority) assertPriority(input.priority);
  const notes = (input.notes ?? "").trim();
  const store = loadStore();
  const todo: Todo = {
    id: genId(),
    title,
    notes,
    project: (input.project ?? "").trim(),
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
    priority: input.priority ?? "med",
    status: "open",
    source: (input.source ?? "").trim(),
    createdAt: now(),
    updatedAt: now(),
    closedAt: null,
  };
  store.todos.push(todo);
  saveStore(store);
  return todo;
}
```

Replace the `text`-handling block inside `updateTodo`:

```ts
  if (patch.title !== undefined) todo.title = normalizeTitle(patch.title);
  if (patch.notes !== undefined) todo.notes = patch.notes.trim();
```

(Remove the old `if (patch.text !== undefined) { ... }` block.)

Add `getTodo` after `updateTodo`:

```ts
export function getTodo(id: string): Todo {
  const store = loadStore();
  return findOrFail(store, id);
}
```

Replace the `text` filter inside `listTodos`:

```ts
  if (filter.text) {
    const q = filter.text.toLowerCase();
    out = out.filter((t) => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
  }
```

Replace `renderOpenBlock`:

```ts
export function renderOpenBlock(max = 15): string {
  const todos = listTodos(); // actionable set, sorted
  if (todos.length === 0) return "## Open TODOs\n(none — no pending cross-session TODOs)\n";
  const shown = todos.slice(0, max);
  const lines = shown.map((t) => {
    const tag = t.project ? ` (${t.project})` : "";
    const pin = t.status === "in_progress" ? " ⏵" : "";
    const dot = t.notes.trim() ? " •" : "";
    return `- [${t.id}] (${t.priority})${pin}${dot} ${t.title}${tag}`;
  });
  const overflow = todos.length > max ? `\n- … +${todos.length - max} more (use \`todo list\`)` : "";
  return `## Open TODOs (${todos.length})\n${lines.join("\n")}${overflow}\n`;
}
```

- [ ] **Step 4: Verify it parses**

Run: `node --check src/todo-store.ts`
Expected: no output (success).

- [ ] **Step 5: Write the failing tests in `test/todo-title-notes.test.mts`**

```ts
// Suite for the title + notes schema split (Workstream B).
// Run: node test/todo-title-notes.test.mts
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "armory-tn-"));
process.env.TODO_DIR = tmp;

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

const { addTodo, updateTodo, getTodo, listTodos, renderOpenBlock, loadStore } =
  await import("../src/todo-store.ts");
const { splitTextFallback } = await import("../src/migrate.ts");

// --- add: title only, notes defaults to "" ---
const t1 = addTodo({ title: "Write SPEC-2", project: "pi", priority: "high", source: "test" });
eq("add title set", t1.title, "Write SPEC-2");
eq("add notes defaults empty", t1.notes, "");
eq("add status open", t1.status, "open");

// --- add: title + notes ---
const t2 = addTodo({ title: "Ship v0.3.0", notes: "Migration first, then panel, then health." });
eq("add notes set", t2.notes, "Migration first, then panel, then health.");

// --- add: trims title before length check ---
const t3 = addTodo({ title: "  trimmed title  " });
eq("add trims title", t3.title, "trimmed title");

// --- add: rejects empty title ---
let threw = false;
try { addTodo({ title: "   " } as any); } catch { threw = true; }
ok("add rejects blank title", threw);

// --- add: rejects title > 120 ---
threw = false;
try { addTodo({ title: "x".repeat(121) }); } catch { threw = true; }
ok("add rejects 121-char title", threw);
const ok120 = addTodo({ title: "y".repeat(120) });
eq("add accepts exactly 120 chars", ok120.title.length, 120);

// --- update: title + notes ---
updateTodo(t1.id, { title: "Write SPEC-2 + SPEC-3", notes: "Block Tuesday for it." });
const t1b = getTodo(t1.id);
eq("update title", t1b.title, "Write SPEC-2 + SPEC-3");
eq("update notes", t1b.notes, "Block Tuesday for it.");

// --- update: notes="" clears ---
updateTodo(t1.id, { notes: "" });
eq("update notes empty clears", getTodo(t1.id).notes, "");

// --- update: rejects title > 120 ---
threw = false;
try { updateTodo(t1.id, { title: "z".repeat(121) }); } catch { threw = true; }
ok("update rejects 121-char title", threw);

// --- get: missing id throws ---
threw = false;
try { getTodo("td-nonexistent"); } catch { threw = true; }
ok("get missing id throws", threw);

// --- list: text filter matches title OR notes ---
addTodo({ title: "unrelated title", notes: "special-token-xyz" });
addTodo({ title: "findme-abc title", notes: "" });
const byNotes = listTodos({ text: "special-token-xyz" });
ok("list text filter matches notes", byNotes.some((t) => t.notes.includes("special-token-xyz")));
const byTitle = listTodos({ text: "findme-abc" });
ok("list text filter matches title", byTitle.some((t) => t.title.includes("findme-abc")));

// --- renderOpenBlock: title only, never notes; dot when notes present ---
const block = renderOpenBlock();
ok("renderOpenBlock includes a title", block.includes("findme-abc"));
ok("renderOpenBlock never includes notes content", !block.includes("special-token-xyz"));
ok("renderOpenBlock has dot for notes-bearing todo", block.includes("•"));

// --- v2→v3 inline derivation on load (fallback, no curated map yet) ---
{
  const dir2 = mkdtempSync(join(tmpdir(), "armory-tn-v2-"));
  const file = join(dir2, "todo.json");
  writeFileSync(file, JSON.stringify({
    version: 2,
    updatedAt: "2026-07-20T10:00:00Z",
    todos: [{
      id: "td-v2-1", text: "First line is the title\nbody detail here",
      project: "", tags: [], priority: "med", status: "open", source: "",
      createdAt: "2026-07-20T10:00:00Z", updatedAt: "2026-07-20T10:00:00Z", closedAt: null,
    }],
  }), "utf8");
  process.env.TODO_DIR = dir2;
  const store = loadStore();
  eq("v2→v3 inline: version 3", store.version, 3);
  eq("v2→v3 inline: title from first line", store.todos[0]!.title, "First line is the title");
  eq("v2→v3 inline: notes from remainder", store.todos[0]!.notes, "body detail here");
  ok("v2→v3 inline: no text field on todo", !("text" in store.todos[0]!));
  process.env.TODO_DIR = tmp;
  rmSync(dir2, { recursive: true, force: true });
}

// --- splitTextFallback unit cases ---
const s1 = splitTextFallback("one liner");
eq("split: single line ≤120 → title=whole, notes=''", s1.title, "one liner");
eq("split: single line notes empty", s1.notes, "");
const s2 = splitTextFallback("first\nsecond\nthird");
eq("split: multiline title=first line", s2.title, "first");
eq("split: multiline notes=rest joined", s2.notes, "second\nthird");
const long = "w".repeat(200);
const s3 = splitTextFallback(long);
ok("split: overlong single-line title ≤120", s3.title.length <= 120);
eq("split: overlong single-line notes=full original", s3.notes, long);
const s4 = splitTextFallback("first line is way too long " + "x".repeat(200) + "\nrest");
ok("split: overlong first-line title ≤120", s4.title.length <= 120);
ok("split: overlong first-line notes starts with full first line", s4.notes.startsWith("first line is way too long "));
ok("split: overlong first-line notes includes rest", s4.notes.endsWith("rest"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 6: Run the new suite to verify it fails**

Run: `node test/todo-title-notes.test.mts`
Expected: FAIL (the import + behaviors are new; some assertions may pass if the impl from Step 3 is in place — but run to confirm at least the suite executes). If the impl from Step 3 is already applied, this should PASS. If run before Step 3, FAIL with import/type errors.

- [ ] **Step 7: Update `test/todo-store.test.mts` — replace all `addTodo({ text: ... })` with `addTodo({ title: ... })`**

Every `addTodo({ text: "X", ... })` call becomes `addTodo({ title: "X", ... })`. Every assertion reading `.text` becomes `.title`. Specific replacements (search for `text:` in addTodo calls and `.text` in assertions):

- `addTodo({ text: "decouple AGENTS.md", ... })` → `addTodo({ title: "decouple AGENTS.md", ... })`
- `addTodo({ text: "research browser-use", ... })` → `addTodo({ title: "research browser-use", ... })`
- `addTodo({ text: "low prio task", ... })` → `addTodo({ title: "low prio task", ... })`
- `addTodo({ text: "sip thing", ... })` → `addTodo({ title: "sip thing", ... })`
- Any `t.text`/`order[i].text` assertion → `t.title`/`order[i].title`.

Also add two reference cap cases at the end (before the final console.log):

```ts
// --- title cap (reference; full cases in todo-title-notes.test.mts) ---
let capThrew = false;
try { addTodo({ title: "a".repeat(121) }); } catch { capThrew = true; }
ok("add rejects >120 title (reference)", capThrew);
const capOk = addTodo({ title: "b".repeat(120) });
eq("add accepts exactly 120 (reference)", capOk.title.length, 120);
```

- [ ] **Step 8: Update the remaining test suites' `addTodo` calls + Todo literals**

For each of `test/todo-archive.test.mts`, `test/todo-config.test.mts`, `test/todo-hard-prune.test.mts`, `test/todo-health.test.mts`, `test/panel-data.test.mts`:

- Replace every `addTodo({ text: "X", ... })` with `addTodo({ title: "X", ... })`.
- Replace every Todo object literal that has `text:` (e.g. in panel-data tests constructing a `Todo` directly) with `title:` + `notes:` (add `notes: ""` if the literal had no notes). Example panel-data literal:
  ```ts
  // before
  { id: "td-1", text: "some todo", project: "pi", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }
  // after
  { id: "td-1", title: "some todo", notes: "", project: "pi", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }
  ```
- Replace assertions reading `.text` → `.title` (e.g. `t.text` in archive/hard-prune tests).
- For `test/panel-data.test.mts`: the existing `todoToItem` assertions check the label contains the text — update to check `title`. (The truncation behavior changes in Task 5; for now just ensure the label contains `title`.)

Run each to confirm:
```bash
node test/todo-archive.test.mts
node test/todo-config.test.mts
node test/todo-hard-prune.test.mts
node test/todo-health.test.mts
node test/panel-data.test.mts
```
Expected: all PASS.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: all 8 suites PASS (baseline 151 + new todo-title-notes cases; the count rises). If any suite fails, fix the missed call site before committing.

- [ ] **Step 10: Commit**

```bash
git add src/todo-store.ts src/migrate.ts test/todo-title-notes.test.mts test/todo-store.test.mts test/todo-archive.test.mts test/todo-config.test.mts test/todo-hard-prune.test.mts test/todo-health.test.mts test/panel-data.test.mts
git commit -m "feat(store): title + notes schema split, v3 store, getTodo, title cap

Todo gains title (≤120, required) + notes (any length); text field removed.
Store.version → 3. addTodo/updateTodo/getTodo use the new fields; listTodos
text filter matches title|notes; renderOpenBlock injects title only (+ •
when notes present). loadStore derives title/notes inline from v2 text
(fallback); the curated map + persist-once land in Task 2. TITLE_MAX=120
hard-rejects at the write boundary.

New suite todo-title-notes.test.mts; all existing addTodo({text}) call sites
updated to {title}. Baseline 151 → grows by the new suite."
```

---

## Task 2: v2→v3 migration module — curated map + persist-once

**Files:**
- Modify: `src/migrate.ts` (add `CURATED_V2_TO_V3` + `migrateV2ToV3`)
- Modify: `src/todo-store.ts` (replace the inline derivation in `loadStore` with `migrateV2ToV3` + `saveStore`)
- Modify: `test/todo-migrate.test.mts` (add v2→v3 cases)

**Interfaces:**
- Consumes: `Todo`, `Store` from `src/todo-store.ts`; `splitTextFallback` (Task 1).
- Produces: `migrateV2ToV3(store): Store` exported from `src/migrate.ts`. `loadStore` now persists the v3 store on first v2 load.

- [ ] **Step 1: Add `CURATED_V2_TO_V3` + `migrateV2ToV3` to `src/migrate.ts`**

Append after `splitTextFallback`:

```ts
// Hand-curated title + notes for the 2 todos known at v2→v3 migration time
// (the only survivors of the v0.2.0 incident). Any other v2 todo uses
// splitTextFallback. Curated notes are reformatted for clarity, not a
// mechanical split.
const CURATED_V2_TO_V3: Record<string, { title: string; notes: string }> = {
  "td-mrt3zp9fcnug3p": {
    title: "ZeroClaw×Solana bounty — Phase 4-5: demo video (score bottleneck, unstarted)",
    notes: `superteam.fun/earn/listing/zeroclaw · Superteam Brasil · 5,000 USDG pool / 1st=1,800 · winner Aug 21 2026 · TARGET #1.

PHASE 0-2 DONE ✅. PHASE 3 (RESEARCH+SPEC+PLAN + impl alerts+custody+docs) DONE ✅ — slices A-F+H, 45 tests, committed 8fd7483→80614c8, PUSHED, PR #76 retitled "Palinurus — depin-attest + depin-rewards", 17 commits.

claim_tx (G) DEFERRED — Helium hotspots are cNFTs → claim needs distribute_compression_rewards_v0 + DAS get_asset_proof (merkle proof), multi-session; PDAs verified, design in README.

Decision (score-max): ship alerts core complete, pivot to DEMO track.

NEXT (★ Phase 4-5, the score bottleneck — submission REQUIRES a demo video, currently unstarted):
(1) ASYNC: RECTOR's free Relay Community key → real Helium fixtures + live smoke test;
(2) Phase 4: wiring SVG (docs/wiring-diagram.svg, dark-mode, NOT ASCII) + marketing site (palinurus.rectorspace.com, Next.js+Tailwind+shadcn) + demo recording guide;
(3) Phase 5: record demo ≤3min (real ZeroClaw+Telegram, terminal+phone) → ElevenLabs voiceover → ffmpeg → submit on Superteam Earn + engage #solana-bounty Discord.

Test totals: 184 (71 palinurus-core + 68 depin-attest + 45 depin-rewards), all clippy+wasm clean.
HANDOFF: ~/Documents/secret/strategy/zeroclaw-solana/session-handoff-2026-07-21.md
Docs: {RESEARCH-3,SPEC-3,PLAN-3}-depin-rewards.md (SPEC-3 §4 + PLAN-3 G corrected for cNFT)
Cwd: ~/local-dev/RECTOR-LABS/zeroclaw-plugins/plugins/depin-rewards
PR: https://github.com/zeroclaw-labs/zeroclaw-plugins/pull/76`,
  },
  "td-mrt4e1qi9td6jz": {
    title: "armory-todo v0.2.0 — Workstream A shipped (lifecycle boxes + prune + health + TUI)",
    notes: `ALL 3 SPECS DONE ✅. SPEC-1 (store: parked+prune+archive+restore, 12 tasks), SPEC-2 (health+hard-prune, 6 tasks), SPEC-3 (interactive /todo TUI panel, 4 tasks). 147/147 tests across 7 suites. 24 commits on feat/spec-1-lifecycle-boxes, PR #3 retitled to full v0.2.0 scope. Auto-publish CI (release.yml, org NPM_TOKEN).

INCIDENT (SPEC-1 Task 9): migration bug destroyed real 52KB/47-todo store (35 done + ~10 open lost, no backup). FIXED (c034509): migration guarded to only run when TODO_DIR is default. RECOVERED: 2 todos.

Shipped: merge PR #3 → tag v0.2.0 → CI auto-publish → npm:@getpipher/armory-todo@0.2.0.
Out of scope: B (title+notes split), C (preventive caps+project registry).`,
  },
};

/** A v2 todo (has `text`, no `title`/`notes`). */
export interface V2Todo {
  id: string;
  text: string;
  project: string;
  tags: string[];
  priority: string;
  status: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** v2 store shape (input to migrateV2ToV3). */
export interface V2Store {
  version: 2;
  updatedAt: string;
  todos: V2Todo[];
}

/** Transform a v2 store into a v3 store: each todo gains title + notes
 *  (curated for the 2 known ids, splitTextFallback for the rest), drops text.
 *  Pure — does not touch disk. Deterministic + idempotent on v2 input. */
export function migrateV2ToV3(store: V2Store): { version: 3; updatedAt: string; todos: any[] } {
  const todos = store.todos.map((t) => {
    const curated = CURATED_V2_TO_V3[t.id];
    if (curated) {
      const { text: _drop, ...rest } = t;
      return { ...rest, title: curated.title, notes: curated.notes };
    }
    const { title, notes } = splitTextFallback(t.text ?? "");
    const { text: _drop, ...rest } = t;
    return { ...rest, title, notes };
  });
  return { version: 3, updatedAt: store.updatedAt, todos };
}
```

- [ ] **Step 2: Verify it parses**

Run: `node --check src/migrate.ts`
Expected: no output (success).

- [ ] **Step 3: Replace the inline derivation in `loadStore` with `migrateV2ToV3` + persist-once**

In `src/todo-store.ts`, update the import:

```ts
import { migrateIfNeeded, migrateV2ToV3 } from "./migrate.ts";
```

Replace the `if (parsed.version === 2) { ... } else if (parsed.version !== 3) { ... }` block in `loadStore` with:

```ts
    if (parsed.version === 2) {
      // v2 → v3: curated map + fallback, persist once so migration runs a single time.
      const migrated = migrateV2ToV3(parsed as any) as unknown as Store;
      saveStore(migrated);
      return migrated;
    }
    if (parsed.version !== 3) {
      throw new Error("invalid store shape");
    }
    return parsed;
```

Remove the now-unused `splitTextFallback` import from `src/todo-store.ts` (it moved into `migrateV2ToV3`):

```ts
import { migrateIfNeeded, migrateV2ToV3 } from "./migrate.ts";
```

- [ ] **Step 4: Verify it parses**

Run: `node --check src/todo-store.ts`
Expected: no output (success).

- [ ] **Step 5: Write the failing tests — append to `test/todo-migrate.test.mts`**

Add before the final `console.log`:

```ts
// --- v2 → v3 migration (migrateV2ToV3) ---
const { migrateV2ToV3 } = await import("../src/migrate.ts");

// Case 4: curated — the 2 known ids get hand-written title + notes
{
  const v2 = {
    version: 2 as const,
    updatedAt: "2026-07-20T17:51:46.838Z",
    todos: [
      { id: "td-mrt3zp9fcnug3p", text: "old junk-drawer blob", project: "bug-bounty", tags: [], priority: "critical", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null },
      { id: "td-mrt4e1qi9td6jz", text: "old armory blob", project: "getpipher", tags: ["a"], priority: "high", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: "x" },
    ],
  };
  const v3 = migrateV2ToV3(v2);
  ok("v2→v3: version 3", v3.version === 3);
  ok("v2→v3: curated ZeroClaw title", v3.todos[0]!.title === "ZeroClaw×Solana bounty — Phase 4-5: demo video (score bottleneck, unstarted)");
  ok("v2→v3: curated ZeroClaw notes start with listing", v3.todos[0]!.notes.startsWith("superteam.fun/earn/listing/zeroclaw"));
  ok("v2→v3: curated armory title", v3.todos[1]!.title === "armory-todo v0.2.0 — Workstream A shipped (lifecycle boxes + prune + health + TUI)");
  ok("v2→v3: curated armory notes mention incident", v3.todos[1]!.notes.includes("INCIDENT"));
  ok("v2→v3: no text field on curated todos", !("text" in v3.todos[0]!) && !("text" in v3.todos[1]!));
  ok("v2→v3: curated preserves project", v3.todos[0]!.project === "bug-bounty" && v3.todos[1]!.project === "getpipher");
}

// Case 5: fallback — single-line text
{
  const v3 = migrateV2ToV3({ version: 2, updatedAt: "x", todos: [{ id: "td-a", text: "just a title", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] });
  ok("v2→v3 fallback single-line: title=whole", v3.todos[0]!.title === "just a title");
  ok("v2→v3 fallback single-line: notes empty", v3.todos[0]!.notes === "");
}

// Case 6: fallback — multi-line text
{
  const v3 = migrateV2ToV3({ version: 2, updatedAt: "x", todos: [{ id: "td-b", text: "the title\nline two\nline three", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] });
  ok("v2→v3 fallback multi-line: title=first line", v3.todos[0]!.title === "the title");
  ok("v2→v3 fallback multi-line: notes=rest", v3.todos[0]!.notes === "line two\nline three");
}

// Case 7: fallback — first line > 120 (truncated title, full first line preserved in notes)
{
  const longFirst = "w".repeat(200);
  const v3 = migrateV2ToV3({ version: 2, updatedAt: "x", todos: [{ id: "td-c", text: `${longFirst}\nrest of it`, project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] });
  ok("v2→v3 fallback overlong: title ≤120", v3.todos[0]!.title.length <= 120);
  ok("v2→v3 fallback overlong: notes starts with full original first line", v3.todos[0]!.notes.startsWith(longFirst));
  ok("v2→v3 fallback overlong: notes ends with rest", v3.todos[0]!.notes.endsWith("rest of it"));
}

// Case 8: persist-once — loadStore migrates a v2 file to v3 on disk
{
  const dir = mkdtempSync(join(tmpdir(), "armory-mig-v3-"));
  const file = join(dir, "todo.json");
  writeFileSync(file, JSON.stringify({ version: 2, updatedAt: "2026-07-20T10:00:00Z", todos: [{ id: "td-p", text: "persist me\nbody", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] }), "utf8");
  process.env.TODO_DIR = dir;
  const { loadStore } = await import("../src/todo-store.ts");
  const store = loadStore();
  ok("persist-once: in-memory version 3", store.version === 3);
  ok("persist-once: title derived", store.todos[0]!.title === "persist me");
  // re-read the file on disk → must now be version 3
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  ok("persist-once: disk version 3", onDisk.version === 3);
  ok("persist-once: disk no text field", !("text" in onDisk.todos[0]));
  ok("persist-once: second load is a no-op (version already 3)", loadStore().version === 3);
  process.env.TODO_DIR = tmp;
  rmSync(dir, { recursive: true, force: true });
}

// Case 9: v2→v3 works under TODO_DIR override (no env guard needed)
{
  const dir = mkdtempSync(join(tmpdir(), "armory-mig-env-"));
  process.env.TODO_DIR = dir;
  const file = join(dir, "todo.json");
  writeFileSync(file, JSON.stringify({ version: 2, updatedAt: "x", todos: [{ id: "td-e", text: "env override ok", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] }), "utf8");
  const { loadStore } = await import("../src/todo-store.ts");
  const store = loadStore();
  ok("v2→v3 under TODO_DIR override: migrates", store.version === 3 && store.todos[0]!.title === "env override ok");
  process.env.TODO_DIR = tmp;
  rmSync(dir, { recursive: true, force: true });
}
```

Note: in Case 4, the curated armory todo's project is `"getpipher"` — fix the assertion `v3.todos[1]!.project` to match the input `"getpipher"` (the v2 input uses `"getpipher"`). Make sure the assertion matches the input.

- [ ] **Step 6: Run the migrate suite**

Run: `node test/todo-migrate.test.mts`
Expected: PASS (all cases including the new 4–9).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all 8 suites PASS.

- [ ] **Step 8: Commit**

```bash
git add src/migrate.ts src/todo-store.ts test/todo-migrate.test.mts
git commit -m "feat(migrate): v2→v3 curated map + persist-once

migrateV2ToV3 in migrate.ts: hand-curated title+notes for the 2 known ids
(td-mrt3zp9fcnug3p ZeroClaw, td-mrt4e1qi9td6jz armory v0.2.0); splitTextFallback
for any other v2 todo. loadStore now calls migrateV2ToV3 + saveStore on a v2
store so the migration runs exactly once (disk becomes v3). No env guard
needed (only touches the live path, temp in tests) — the v1→v2 file-move
guard stays as-is. Extends todo-migrate.test.mts with curated + fallback +
persist-once + TODO_DIR-override cases."
```

---

## Task 3: Archive v3 + listArchived filter

**Files:**
- Modify: `src/archive.ts` (`ArchiveStore.version: 3`; `loadArchive` runs `migrateV2ToV3` on a v2 archive; `listArchived` text filter → title|notes)
- Modify: `test/todo-archive.test.mts` (listArchived title+dot is extension-level — here test the filter + v2 archive migration)

**Interfaces:**
- Consumes: `migrateV2ToV3` from `src/migrate.ts`; `Todo` from `src/todo-store.ts`.
- Produces: `ArchiveStore { version: 3 }`; `loadArchive` migrates v2 archives on load.

- [ ] **Step 1: Update `src/archive.ts`**

Change `ArchiveStore` version:

```ts
export interface ArchiveStore {
  version: 3;
  updatedAt: string;
  todos: Todo[];
}
```

Change `emptyArchive`:

```ts
function emptyArchive(): ArchiveStore {
  return { version: 3, updatedAt: now(), todos: [] };
}
```

Add the import of `migrateV2ToV3`:

```ts
import { migrateV2ToV3 } from "./migrate.ts";
```

In `loadArchive`, after `const parsed = JSON.parse(raw) as ArchiveStore;` and the shape check, replace the `return parsed;` (the happy path) with version-aware logic. The current happy-path tail is:

```ts
    return parsed;
  } catch {
```

Replace with:

```ts
    if (parsed.version === 2) {
      const migrated = migrateV2ToV3(parsed as any) as unknown as ArchiveStore;
      saveArchive(migrated);
      return migrated;
    }
    if (parsed.version !== 3) {
      throw new Error("invalid archive shape");
    }
    return parsed;
  } catch {
```

Change the `listArchived` text filter:

```ts
  if (filter.text) {
    const q = filter.text.toLowerCase();
    out = out.filter((t) => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
  }
```

- [ ] **Step 2: Verify it parses**

Run: `node --check src/archive.ts`
Expected: no output (success).

- [ ] **Step 3: Write the failing tests — append to `test/todo-archive.test.mts`**

Add before the final `console.log`:

```ts
// --- v2 archive → v3 on load (symmetric with live store) ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-arc-v3-"));
  process.env.TODO_DIR = dir;
  const arcFile = join(dir, "todo-archive.json");
  writeFileSync(arcFile, JSON.stringify({
    version: 2,
    updatedAt: "x",
    todos: [{ id: "td-arc-1", text: "done thing\nwith detail", project: "pi", tags: [], priority: "med", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: "2026-07-01T00:00:00Z" }],
  }), "utf8");
  const { loadArchive, listArchived } = await import("../src/archive.ts");
  const arc = loadArchive();
  ok("archive v2→v3: version 3", arc.version === 3);
  ok("archive v2→v3: title derived", arc.todos[0]!.title === "done thing");
  ok("archive v2→v3: notes derived", arc.todos[0]!.notes === "with detail");
  ok("archive v2→v3: no text field", !("text" in arc.todos[0]!));
  // persisted to disk
  const onDisk = JSON.parse(readFileSync(arcFile, "utf8"));
  ok("archive v2→v3: disk version 3", onDisk.version === 3);
  // listArchived text filter matches title OR notes
  const byTitle = listArchived({ text: "done thing", limit: 50 });
  ok("archive listArchived text matches title", byTitle.items.some((t) => t.title === "done thing"));
  const byNotes = listArchived({ text: "with detail", limit: 50 });
  ok("archive listArchived text matches notes", byNotes.items.some((t) => t.notes === "with detail"));
  process.env.TODO_DIR = tmp;
  rmSync(dir, { recursive: true, force: true });
}
```

Ensure `readFileSync` is imported at the top of the file (add to the existing `node:fs` import if missing).

- [ ] **Step 4: Run the archive suite**

Run: `node test/todo-archive.test.mts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all 8 suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/archive.ts test/todo-archive.test.mts
git commit -m "feat(archive): v3 archive + listArchived title|notes filter

ArchiveStore.version → 3; loadArchive migrates a v2 archive file to v3 on
load (curated + fallback, persist-once) — symmetric with the live store.
listArchived text filter now matches title OR notes. The archive file does
not exist today (the v0.2.0 incident left none), but the guard is defensive
for restored/future archives."
```

---

## Task 4: Extension tool surface — `get` action, title/notes params, prompt guidelines

**Files:**
- Modify: `extensions/todo.ts` (ACTIONS + `get`; input schema; `fmt`; add/update/complete/delete/park/restore/clear/prune output → title; `get` handler; prompt guidelines; `/todo add <title>`)

**Interfaces:**
- Consumes: `getTodo` from `src/todo-store.ts` (Task 1); `title`/`notes` on `Todo`.
- Produces: the model-callable `todo` tool with the new surface. Manual-gate (no unit test — verified by `node --check` + RECTOR QA).

- [ ] **Step 1: Update `ACTIONS` + imports**

Add `getTodo` to the import from `../src/todo-store`:

```ts
import {
  addTodo,
  completeTodo,
  deleteTodo,
  clearTodos,
  getTodo,
  listTodos,
  renderOpenBlock,
  updateTodo,
  parkTodo,
  getStorePath,
} from "../src/todo-store";
```

Change `ACTIONS`:

```ts
const ACTIONS = ["list", "add", "update", "get", "complete", "delete", "clear", "park", "prune", "restore", "health"] as const;
```

- [ ] **Step 2: Replace `fmt`**

```ts
function fmt(t: ReturnType<typeof listTodos>[number]): string {
  const tag = t.project ? ` (${t.project})` : "";
  const pins = t.tags.length ? ` #${t.tags.join(" #")}` : "";
  const dot = t.notes.trim() ? " •" : "";
  return `- [${t.id}] (${t.priority}/${t.status})${dot} ${t.title}${tag}${pins}`;
}
```

- [ ] **Step 3: Add a `fmtFull` for the `get` action**

After `fmt`:

```ts
function fmtFull(t: ReturnType<typeof getTodo>): string {
  const tag = t.project ? ` (${t.project})` : "";
  const tags = t.tags.length ? ` #${t.tags.join(" #")}` : "";
  return [
    `${t.id} [${t.priority}/${t.status}] ${t.title}${tag}${tags}`,
    `created: ${t.createdAt}`,
    `updated: ${t.updatedAt}`,
    `closed: ${t.closedAt ?? "(open)"}`,
    `source: ${t.source || "(none)"}`,
    "",
    "notes:",
    t.notes || "(empty)",
  ].join("\n");
}
```

- [ ] **Step 4: Update the input schema — add `title` + `notes`, rewrite `text`**

Replace the `text` parameter line:

```ts
      text: Type.Optional(Type.String({ description: "Search query (list only) — substring match on title OR notes. Not used by add/update." })),
```

Add `title` + `notes` (place them right after `id`):

```ts
      title: Type.Optional(Type.String({ description: "Todo title (add required; update optional). ≤120 chars; put detail in notes." })),
      notes: Type.Optional(Type.String({ description: "Todo notes/body (add/update optional; long-form, not injected). Pass \"\" on update to clear." })),
```

- [ ] **Step 5: Rewrite the `add` case**

```ts
          case "add": {
            if (!params.title) {
              return { content: [{ type: "text" as const, text: "Error: `title` is required for add." }] };
            }
            const t = addTodo({
              title: params.title,
              notes: params.notes,
              project: params.project,
              tags: params.tags,
              priority: params.priority as any,
              source: params.source as any,
            });
            return { content: [{ type: "text" as const, text: `Added ${t.id}: ${t.title}` }] };
          }
```

- [ ] **Step 6: Rewrite the `update` case**

```ts
          case "update": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for update." }] };
            const t = updateTodo(params.id, {
              title: params.title,
              notes: params.notes,
              project: params.project,
              tags: params.tags,
              priority: params.priority as any,
              status: params.status as any,
            });
            return { content: [{ type: "text" as const, text: `Updated ${t.id}: ${t.title} [${t.status}]` }] };
          }
```

- [ ] **Step 7: Add the `get` case (after `update`)**

```ts
          case "get": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for get." }] };
            const t = getTodo(params.id);
            return { content: [{ type: "text" as const, text: fmtFull(t) }] };
          }
```

- [ ] **Step 8: Update the output lines for complete/delete/park/restore to use `title`**

```ts
          case "complete": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for complete." }] };
            const t = completeTodo(params.id);
            return { content: [{ type: "text" as const, text: `Completed ${t.id}: ${t.title}` }] };
          }
          case "delete": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for delete." }] };
            const t = deleteTodo(params.id);
            return { content: [{ type: "text" as const, text: `Cancelled ${t.id}: ${t.title}` }] };
          }
          case "park": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for park." }] };
            const t = parkTodo(params.id);
            return { content: [{ type: "text" as const, text: `Parked ${t.id}: ${t.title}` }] };
          }
```

And the `restore` case:

```ts
            const t = restoreTodo(params.id);
            return { content: [{ type: "text" as const, text: `Restored ${t.id}: ${t.title} [open]` }] };
```

- [ ] **Step 9: Rewrite `promptGuidelines`**

Replace the whole `promptGuidelines: [...]` array with:

```ts
    promptGuidelines: [
      "Use todo (action:'add', title, notes?, project?, tags?, priority?, source?) when the user says 'put this in our TODO'. title is ≤120 chars (one-line summary); put long detail in notes.",
      "Use todo (action:'get', id) to read a todo's full notes before acting on it (the • marker in lists means notes exist).",
      "Use todo (action:'update', id, title?, notes?, project?, tags?, priority?, status?) to edit; notes=\"\" clears.",
      "Use todo (action:'list') when the user asks 'show me the TODO' / 'what's pending' (text filter searches title+notes).",
      "Use todo (action:'complete', id) to mark a TODO done; (action:'delete', id) to cancel it.",
      "Use todo (action:'park', id) to defer a TODO (not injected, recoverable); (action:'update', id, status:'open') to un-park.",
      "Use todo (action:'prune') to move done/cancelled todos to the archive (reversible); (action:'prune', all:true) to prune all regardless of age.",
      "Use todo (action:'restore', id) to bring an archived TODO back as open.",
      "Use todo (action:'list', archived:true) to query the archive — bare call returns a summary; add a filter (project/text/since) for specific items.",
      "Use todo (action:'health') to check bloat across all boxes — returns counts + flags + suggestions. Run this when the user asks about hygiene/bloat or before any hard-prune.",
      "Use todo (action:'prune', hard:true, confirm:true, box?, olderThan?) for PERMANENT deletion — the only irreversible action. ALWAYS: run `health` first, show the user the report + the exact proposed command, and wait for an explicit 'yes' before passing confirm:true. Never hard-prune without explicit user confirmation.",
    ],
```

- [ ] **Step 10: Update the `/todo add` slash subcommand**

Replace the `if (sub === "add") { ... }` block:

```ts
        if (sub === "add") {
          const title = rest.join(" ").trim();
          if (!title) { if (ctx.hasUI) ctx.ui.notify("usage: /todo add <title>  (notes via the todo tool)", "warning"); return; }
          const t = addTodo({ title, source: "slash" });
          if (ctx.hasUI) ctx.ui.notify(`Added ${t.id}: ${t.title}`, "info");
          return;
        }
```

- [ ] **Step 11: Update the slash command description**

Replace the `description:` string:

```ts
    description:
      "Global cross-session TODO list. " +
      "/todo · /todo all · /todo add <title> · /todo done <id> · /todo rm <id> · " +
      "/todo park <id> · /todo restore <id> · /todo prune [--all|--hard --box <b> --older-than <d>] · " +
      "/todo archive [project:X|text:Y] · /todo health · /todo clean · /todo path",
```

- [ ] **Step 12: Update remaining slash output lines that used `t.text`**

In the slash handler, the `park` and `restore` notify lines use `t.text`:

```ts
        if (sub === "park") {
          const id = rest[0];
          if (!id) { if (ctx.hasUI) ctx.ui.notify("usage: /todo park <id>", "warning"); return; }
          const t = parkTodo(id);
          if (ctx.hasUI) ctx.ui.notify(`Parked ${t.id}: ${t.title}`, "info");
          return;
        }
        if (sub === "restore") {
          const id = rest[0];
          if (!id) { if (ctx.hasUI) ctx.ui.notify("usage: /todo restore <id>", "warning"); return; }
          const t = restoreTodo(id);
          if (ctx.hasUI) ctx.ui.notify(`Restored ${t.id}: ${t.title}`, "info");
          return;
        }
```

- [ ] **Step 13: Verify it parses**

Run: `node --check extensions/todo.ts`
Expected: no output (success).

- [ ] **Step 14: Run the full suite (no new tests — extension is manual-gate)**

Run: `npm test`
Expected: all 8 suites PASS (extension isn't loaded by the suites).

- [ ] **Step 15: Commit**

```bash
git add extensions/todo.ts
git commit -m "feat(ext): get action + title/notes params + prompt guidelines

ACTIONS gains get (returns a todo's full record incl notes via fmtFull).
add requires title (+ optional notes); update gains title+notes, drops text.
list.text searches title+notes; fmt shows title + • when notes present.
complete/delete/park/restore/clear output lines use title. Prompt guidelines
rewritten to teach title (≤120) + notes + get. /todo add <title> (notes via
the tool). Extension is manual-gate (node --check + RECTOR QA)."
```

---

## Task 5: Panel — title list, read-only notes detail view, title-only Edit

**Files:**
- Modify: `src/panel-data.ts` (`todoToItem` → title+dot, delete truncation; `actionsForTodo` "Edit text"→"Edit title")
- Modify: `src/panel.ts` (detail view rendering notes read-only; Edit writes `title`; detail-view Back)
- Modify: `test/panel-data.test.mts` (todoToItem title+dot assertions)

**Interfaces:**
- Consumes: `Todo.title`/`Todo.notes` from Task 1.
- Produces: `todoToItem` label = `[id] (prio)⏵ (project) • title` (dot when notes present). Panel detail view + title-only Edit.

- [ ] **Step 1: Rewrite `todoToItem` in `src/panel-data.ts`**

```ts
/** Format a todo as a SelectList item: "[id] (prio)⏵ (project) • title".
 *  title is already ≤120 chars (enforced at write time), so no truncation is
 *  needed. The • marker shows when notes is non-empty (signals "open the
 *  detail view / use `todo get` for context"). */
export function todoToItem(t: Todo): SelectItem {
  const pin = t.status === "in_progress" ? " ⏵" : "";
  const proj = t.project ? ` (${t.project})` : "";
  const dot = t.notes.trim() ? " •" : "";
  return {
    value: t.id,
    label: `[${t.id}] (${t.priority})${pin}${proj}${dot} ${t.title}`,
  };
}
```

- [ ] **Step 2: Rename "Edit text" → "Edit title" in `actionsForTodo`**

```ts
  actions.push({ label: "Edit title", action: "edit" });
```

- [ ] **Step 3: Update `test/panel-data.test.mts` — `todoToItem` assertions**

Replace any existing `todoToItem` assertions that checked the label contains `text` / truncation behavior:

```ts
// --- todoToItem: title + dot ---
const { todoToItem, actionsForTodo } = await import("../src/panel-data.ts");

const noNotes: Todo = { id: "td-1", title: "Simple title", notes: "", project: "pi", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null };
const itemNoNotes = todoToItem(noNotes);
ok("todoToItem: label has title", itemNoNotes.label.includes("Simple title"));
ok("todoToItem: no • when notes empty", !itemNoNotes.label.includes("•"));

const withNotes: Todo = { id: "td-2", title: "Has detail", notes: "lots of context", project: "pi", tags: [], priority: "high", status: "in_progress", source: "", createdAt: "x", updatedAt: "x", closedAt: null };
const itemWithNotes = todoToItem(withNotes);
ok("todoToItem: label has • when notes present", itemWithNotes.label.includes("•"));
ok("todoToItem: label has title not notes content", itemWithNotes.label.includes("Has detail") && !itemWithNotes.label.includes("lots of context"));
ok("todoToItem: in_progress pin present", itemWithNotes.label.includes("⏵"));

// --- actionsForTodo: "Edit title" (renamed from "Edit text") ---
const acts = actionsForTodo(noNotes);
ok("actionsForTodo: has 'Edit title'", acts.some((a) => a.label === "Edit title" && a.action === "edit"));
ok("actionsForTodo: no 'Edit text' (renamed)", !acts.some((a) => a.label === "Edit text"));
```

Ensure `Todo` is imported at the top:

```ts
import type { Todo } from "../src/todo-store.ts";
```

- [ ] **Step 4: Run the panel-data suite**

Run: `node test/panel-data.test.mts`
Expected: PASS.

- [ ] **Step 5: Add the detail view + title-only Edit to `src/panel.ts`**

Add a `detailMode` + `detailId` state near the other mode flags in the `TodoPanel` class:

```ts
  private detailMode = false;
  private detailId = "";
```

Add a `viewDetail(id)` method that loads the todo and switches to detail mode. Place it after `openActionSubmenu`:

```ts
  private viewDetail(id: string): void {
    const all = listTodos({ status: "all", limit: 200 });
    const t = all.find((x) => x.id === id);
    if (!t) { this.onNotify("Todo not found.", "info"); return; }
    this.detailId = id;
    this.actionMode = false;
    this.actionList = null;
    this.editMode = false;
    this.renderShell();
  }
```

In `renderShell`, add a branch for detail mode. Insert this `else if` before the `this.currentBox === "config"` branch (and after the edit/action branches):

```ts
    } else if (this.detailMode) {
      const all = listTodos({ status: "all", limit: 200 });
      const t = all.find((x) => x.id === this.detailId);
      if (!t) { this.detailMode = false; this.renderShell(); return; }
      const proj = t.project || "no project";
      const tags = t.tags.length ? t.tags.join(" ") : "(none)";
      this.addChild(new Text(this.theme.fg("accent", `  ${t.title}`), 0, 0));
      this.addChild(new Text(this.theme.fg("muted", `  (${t.priority}/${t.status}) · ${proj} · #${tags}`), 0, 0));
      this.addChild(new Spacer(1));
      this.addChild(new Text(this.theme.fg("dim", "  notes:"), 0, 0));
      this.addChild(new Text(`  ${t.notes || "(empty)"}`, 0, 0));
      this.addChild(new Spacer(1));
      this.addChild(new Text(this.theme.fg("dim", "  notes: read-only · todo update <id> notes=… to edit"), 0, 0));
    } else if (this.currentBox === "config") {
```

Add a "View detail" action to the action submenu. In `openActionSubmenu`, prepend a View action to `acts`:

```ts
    const acts = [{ label: "View detail", action: "view" }, ...actionsForTodo(todo)];
```

In `executeAction`, add the `view` case (at the top of the switch):

```ts
        case "view": this.viewDetail(id); return;
```

Change the `edit` case to edit `title` instead of `text`:

```ts
        case "edit": {
          const all = listTodos({ status: "all", limit: 200 });
          const t = all.find((x) => x.id === id);
          this.editId = id;
          this.editInput = new Input();
          this.editInput.setValue(t?.title ?? "");
          this.editInput.onSubmit = (value) => {
            if (value.trim()) {
              try { updateTodo(id, { title: value.trim() }); this.onNotify(`Edited ${id}`); }
              catch (err) { this.onNotify(`Error: ${(err as Error).message}`, "error"); }
            }
            this.exitEditMode();
          };
          this.editInput.onEscape = () => this.exitEditMode();
          this.actionMode = false;
          this.actionList = null;
          this.editMode = true;
          this.renderShell();
          break;
        }
```

In `handleInput`, add a branch for detail mode (Esc/Back returns to list). Insert after the edit-mode branch:

```ts
    if (this.detailMode) {
      if (matchesKey(data, "escape") || matchesKey(data, "esc") || matchesKey(data, "enter") || matchesKey(data, "return")) {
        this.detailMode = false;
        this.detailId = "";
        this.refreshList();
        this.renderShell();
        return;
      }
      this.invalidate();
      return;
    }
```

Update the footer hint to mention the detail view. Replace the existing footer Text:

```ts
    this.addChild(new Text(this.theme.fg("dim", "  ↑↓ navigate • enter select/action • tab switch box • esc done"), 0, 0));
```

(no change needed — "enter select/action" covers it; the detail view's own hints are inline.)

- [ ] **Step 6: Verify both files parse**

Run: `node --check src/panel.ts && node --check src/panel-data.ts`
Expected: no output (success).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all 8 suites PASS (panel.ts is manual-gate; panel-data tests cover the pure helpers).

- [ ] **Step 8: Commit**

```bash
git add src/panel-data.ts src/panel.ts test/panel-data.test.mts
git commit -m "feat(panel): title list + read-only notes detail view + title-only Edit

todoToItem shows title + • (when notes present); the ~80-char truncation hack
is deleted (title is already ≤120 by the cap). New detail view (View detail
action / enter on a row): renders title + full notes read-only with a footer
hint 'notes: read-only · todo update <id> notes=… to edit'. Inline Edit now
edits title only (single-line Input — same constraint as v0.2.0); notes
editing via the todo tool. Known deferred issue: no in-panel multi-line notes
edit (pi-tui nested-UI blocker). 'Edit text' action renamed to 'Edit title'."
```

---

## Task 6: Health notes-bytes diagnostic

**Files:**
- Modify: `src/health.ts` (add `notesBytes` to `HealthReport`; compute across active+parked)
- Modify: `extensions/todo.ts` (health output line + `/todo health` slash line)
- Modify: `test/todo-health.test.mts` (notesBytes assertions)

**Interfaces:**
- Consumes: `Todo.notes` from Task 1.
- Produces: `HealthReport.notesBytes: { total: number; max: number; avg: number }`.

- [ ] **Step 1: Add `notesBytes` to `HealthReport` in `src/health.ts`**

Add the interface:

```ts
export interface NotesBytes {
  total: number;
  max: number;
  avg: number;
}
```

Add to `HealthReport`:

```ts
export interface HealthReport {
  active: ActiveHealth;
  parked: ParkedHealth;
  archive: ArchiveHealth;
  notesBytes: NotesBytes;
  flags: HealthFlag[];
  suggestions: string[];
}
```

In `healthReport`, compute notesBytes across active + parked (not archived). After the `archiveOld` computation, add:

```ts
  const apTodos = [...openTodos, ...ipTodos, ...parkedTodos];
  const notesSizes = apTodos.map((t) => Buffer.byteLength(t.notes, "utf8"));
  const notesBytes: NotesBytes = {
    total: notesSizes.reduce((a, b) => a + b, 0),
    max: notesSizes.length ? Math.max(...notesSizes) : 0,
    avg: notesSizes.length ? Math.round(notesSizes.reduce((a, b) => a + b, 0) / notesSizes.length) : 0,
  };
```

Include `notesBytes` in the returned object:

```ts
  return { active, parked, archive: arch, notesBytes, flags, suggestions };
```

- [ ] **Step 2: Verify it parses**

Run: `node --check src/health.ts`
Expected: no output (success).

- [ ] **Step 3: Write the failing tests — append to `test/todo-health.test.mts`**

Add before the final `console.log`:

```ts
// --- notesBytes: total/max/avg across active+parked (archived excluded) ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-health-notes-"));
  process.env.TODO_DIR = dir;
  const { addTodo, completeTodo, parkTodo } = await import("../src/todo-store.ts");
  const { healthReport } = await import("../src/health.ts");
  addTodo({ title: "a", notes: "short" });                       // 5 bytes
  addTodo({ title: "b", notes: "x".repeat(100) });               // 100 bytes
  const parked = addTodo({ title: "c", notes: "y".repeat(40) }); // 40 bytes
  parkTodo(parked.id);
  const done = addTodo({ title: "d", notes: "z".repeat(999) });  // archived-excluded
  completeTodo(done.id);
  // prune to move `done` into the archive so it's excluded from the active+parked set
  const { pruneTodos } = await import("../src/archive.ts");
  pruneTodos({ all: true });
  const r = healthReport();
  ok("notesBytes: total = 5+100+40", r.notesBytes.total === 145);
  ok("notesBytes: max = 100", r.notesBytes.max === 100);
  ok("notesBytes: avg = round(145/3) = 48", r.notesBytes.avg === 48);
  ok("notesBytes: excludes archived (999 not in total)", r.notesBytes.total < 999);
  process.env.TODO_DIR = tmp;
  rmSync(dir, { recursive: true, force: true });
}

// --- notesBytes: empty store → zeros ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-health-empty-"));
  process.env.TODO_DIR = dir;
  const { healthReport } = await import("../src/health.ts");
  const r = healthReport();
  eq("notesBytes empty: total 0", r.notesBytes.total, 0);
  eq("notesBytes empty: max 0", r.notesBytes.max, 0);
  eq("notesBytes empty: avg 0", r.notesBytes.avg, 0);
  process.env.TODO_DIR = tmp;
  rmSync(dir, { recursive: true, force: true });
}
```

Ensure `eq` is defined in the file (it is — todo-health uses ok/eq like the others). Ensure `mkdtempSync`, `rmSync`, `tmpdir`, `join` are imported.

- [ ] **Step 4: Run the health suite**

Run: `node test/todo-health.test.mts`
Expected: PASS.

- [ ] **Step 5: Add the notesBytes line to the extension `health` output + `/todo health` slash output**

In `extensions/todo.ts`, the tool `health` case — add a line after the `archive:` line:

```ts
              `archive: ${report.archive.count} (${report.archive.older_180d} old)`,
              `notes:   ${report.notesBytes.total}B total · max ${report.notesBytes.max}B · avg ${report.notesBytes.avg}B`,
```

In the `/todo health` slash handler, add the same line after the `archive:` line:

```ts
            `  archive: ${report.archive.count} (${report.archive.older_180d} old)`,
            `  notes:   ${report.notesBytes.total}B total · max ${report.notesBytes.max}B · avg ${report.notesBytes.avg}B`,
```

- [ ] **Step 6: Verify it parses**

Run: `node --check extensions/todo.ts`
Expected: no output (success).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all 8 suites PASS.

- [ ] **Step 8: Commit**

```bash
git add src/health.ts extensions/todo.ts test/todo-health.test.mts
git commit -m "feat(health): notes-bytes diagnostic (total/max/avg, active+parked)

HealthReport gains notesBytes { total, max, avg } computed across active +
parked (archived excluded — sealed history). Read-only diagnostic: shows
latent notes bloat that isn't injected. No caps enforced in B (Workstream C).
Extension + /todo health output a 'notes: NB total · max NB · avg NB' line."
```

---

## Task 7: Docs + version bump + ship prep

**Files:**
- Modify: `README.md` (schema section: title+notes; known issues; test count)
- Modify: `AGENTS.md` (modules list reflects v3; known deferred issues)
- Modify: `package.json` (`version: 0.3.0`)
- Modify: `docs/superpowers/specs/2026-07-21-title-notes-split-design.md` (status → shipped, after RECTOR QA)

**Interfaces:** none (docs + version).

- [ ] **Step 1: Bump `package.json` version**

```bash
# edit package.json: "version": "0.2.0" → "0.3.0"
```

- [ ] **Step 2: Update `README.md`**

- In the structure/feature section, replace references to the `text` field with `title` + `notes`.
- Update the test count line ("151/151 across 7 suites" → the new count from `npm test`; 8 suites now).
- Add a "Known issues" bullet: "No in-panel multi-line notes editing (pi-tui nested-UI blocker); notes are model-managed via the `todo` tool."
- Add a schema note: "`title` ≤120 chars (hard-capped, injected); `notes` any length (not injected)."

- [ ] **Step 3: Update `AGENTS.md`**

- In the "Notes" section, update the version references (v0.2.0 → v0.3.0) and add the title/notes split to the lifecycle description.
- Add the known deferred issue (in-panel notes edit) to the "Open follow issue" line alongside Workstream C.
- Update the test count if cited.

- [ ] **Step 4: Run the full suite + syntax checks one final time**

Run:
```bash
npm test
node --check extensions/todo.ts
node --check src/panel.ts
node --check src/health.ts
node --check src/archive.ts
node --check src/todo-store.ts
node --check src/migrate.ts
node --check src/panel-data.ts
```
Expected: all suites PASS; all `--check` silent.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md AGENTS.md
git commit -m "docs(v0.3.0): title+notes schema, known issues, version bump

README + AGENTS updated for the title (≤120, injected) + notes (any length,
not injected) split, the new get action, and the known deferred issue
(no in-panel multi-line notes edit). package.json → 0.3.0."
```

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin feat/title-notes-split
gh pr create --base main --head feat/title-notes-split \
  --title "Workstream B — title + notes schema split (v0.3.0)" \
  --body "Bumps store to v3. Splits the single text field into title (≤120, injected) + notes (any length, not injected). New get action. Hard title cap. v2→v3 migration (curated for the 2 known ids + first-line fallback, persist-once). Panel detail view for notes; title-only Edit. Health notes-bytes diagnostic. Closes the v0.2.0 'no title field' gap. See docs/superpowers/specs/2026-07-21-title-notes-split-design.md."
```

- [ ] **Step 7: RECTOR QA gate (manual — do NOT merge until RECTOR signs off)**

Local install + restart pi, then verify in a real session:
1. v2→v3 migration runs on first load → the 2 known todos get curated title+notes; `~/.pi/agent/todo/todo.json` is version 3 on disk.
2. `## Open TODOs` injection shows the ZeroClaw *title* (+ `•`), not the 1.8KB blob.
3. `/todo` panel: list rows show titles + `•`; View detail shows notes read-only; Edit edits title; `•` appears iff notes non-empty.
4. `todo add` with `title`+`notes` works; `todo get <id>` returns notes; `todo update <id> notes=…` edits notes; `todo update <id> title=…` edits title.
5. Title >120 rejects with the actionable error.
6. `/todo health` shows the `notes:` bytes line.

- [ ] **Step 8: After QA sign-off — merge + tag**

```bash
gh pr merge --merge --delete-branch
git checkout main && git pull
git tag v0.3.0
git push origin v0.3.0   # triggers release.yml → npm auto-publish
```

Verify publish:
```bash
npm view @getpipher/armory-todo version   # → 0.3.0
```

- [ ] **Step 9: Mark the spec shipped**

In `docs/superpowers/specs/2026-07-21-title-notes-split-design.md`, change the status line:

```
**Status:** Shipped (v0.3.0, PR #<N>, <date>)
```

Commit + push:
```bash
git add docs/superpowers/specs/2026-07-21-title-notes-split-design.md
git commit -m "docs(spec): Workstream B shipped (v0.3.0)"
git push
```

---

## Self-Review (run after writing the plan)

**Spec coverage:**
- §5 schema → Task 1 ✓
- §6 migration (curated + fallback + persist-once + no env guard) → Task 2 ✓
- §7 tool surface (get, add/update title+notes, list.text title|notes, prompt guidelines, slash) → Task 4 ✓
- §8 injection (title only + •) → Task 1 (renderOpenBlock) ✓
- §9 panel (list title+•, detail view, title-only Edit, known deferred issue) → Task 5 ✓
- §10 health notes-bytes → Task 6 ✓
- §11 archive v3 + listArchived filter → Task 3 ✓
- §12 tests → Tasks 1–6 each carry their own test steps ✓
- §13 branch + ship → Task 7 ✓
- §14 incident lesson (v2→v3 no env guard; v1→v2 guard preserved) → Task 2 notes + Global Constraints ✓

**Placeholder scan:** none — every step has exact code or exact commands.

**Type consistency:** `getTodo`, `TITLE_MAX`, `splitTextFallback`, `migrateV2ToV3`, `notesBytes`, `fmtFull`, `viewDetail`, `detailMode` — names match across tasks. `Todo`/`Store`/`AddInput`/`UpdateInput` shapes are consistent. `ArchiveStore.version: 3` matches `Store.version: 3`. (Fixed: Task 2 Case 4 project assertion uses `"getpipher"` matching the v2 input.)