# Workstream v0.3.1 — auto-prune + unified Done view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Pi has no core subagent tool → execute sequentially inline, checkpoint per task.)

**Goal:** Make `done`/`cancelled` todos auto-archive on `session_start` (age-gated, silent when clean, rich notify) and give finished work a single home — a unified `Done` listing (`todo list status:done` + `/todo done` + a new `Done` panel tab) spanning live + archive — without changing the injection contract (only `open`+`in_progress` injected).

**Architecture:** A pure `autoPruneOnSessionStart()` in a new `src/auto-prune.ts` wraps `pruneTodos` (age-gated, never `--all`); the extension's `session_start` handler calls it + notifies. `pruneTodos` gains a rich `items` result (id+status+title+ageDays) used by both auto + manual prune. A new `listDoneUnified()` in `archive.ts` merges live-done + archived-done (excludes `cancelled`, sorted newest-closed first, location-tagged) — consumed by the `todo list status:done` tool, the `/todo done` slash, and a new `Done` box tab in the panel. The Archive tab + `--all`/`--hard` are unchanged.

**Tech Stack:** TypeScript (raw `.ts`, tsx at pi runtime), node:test-style custom harness (temp `TODO_DIR`), typebox schemas, `@earendil-works/pi-tui` panel. Zero runtime deps (node:fs only).

## Global Constraints

- **Zero runtime deps** (node:fs only). 2-space indent. No TODO/FIXME. No AI attribution.
- **Injection contract UNCHANGED:** `renderOpenBlock` + `listTodos` default filter (`open`+`in_progress`) are not touched. Auto-prune moves done→archive (both non-injected) → zero injection impact.
- **Auto-prune is age-gated, never `--all`:** stale = `closedAt` older than `config.prune.defaultAgeDays` (default 7). Fresh done (<7d) stays in live. `--all` remains manual-only.
- **`cancelled` excluded from the Done view** (Done = finished work; cancelled = abandoned → Archive tab only).
- **Reversible, no gate** for auto-prune (it's `prune`, not `--hard`). The `--hard` gate stays untouched.
- **Reuses `config.prune.defaultAgeDays`** — no new config key.
- **Tests:** baseline 220 across 8 suites → target ~240+. New `test/todo-auto-prune.test.mts`. Extend `todo-archive` + `panel-data`. Run via `npm test`. Syntax-check extension/panel with `node --check`.
- **Branch:** `feat/auto-prune-done-view` off `main`. Commits: `feat(scope): ...` per task. PR → `--merge --delete-branch`. No GitLab mirror. Tag `v0.3.1` after RECTOR QA → CI auto-publishes npm + creates GitHub Release.
- **Rich result always-on** (resolves spec §12): `pruneTodos` always returns `items` (no `detail` flag). Callers that only need `{moved, ids}` ignore `items`. Cost is trivial (ageDays per moved todo).

**Spec:** `docs/superpowers/specs/2026-07-21-auto-prune-done-view-design.md`

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/archive.ts` | `pruneTodos` returns rich `items` (id+status+title+ageDays); new `listDoneUnified()` + `DoneItem` type | 1, 2 |
| `src/auto-prune.ts` | NEW — `autoPruneOnSessionStart(): PruneDetail \| null` (wraps `pruneTodos`, age-gated) | 4 |
| `extensions/todo.ts` | `session_start` auto-prune + rich notify; `todo list status:done` → unified; manual `prune` rich output; `/todo done` slash; prompt guidelines | 3, 4 |
| `src/panel-data.ts` | `todoDoneItem` (location-tagged label) + `actionsForDoneTodo` | 5 |
| `src/panel.ts` | `BOXES` + `done` tab; `refreshList` Done branch; done-row action submenu (View detail + Restore-from-archive) | 5 |
| `test/todo-auto-prune.test.mts` | NEW — autoPruneOnSessionStart: stale moves, fresh stays, no-op clean, idempotent, cancelled, rich items | 4 |
| `test/todo-archive.test.mts` | pruneTodos rich items+ageDays; listDoneUnified (merge, exclude cancelled, sort, location, filters) | 1, 2 |
| `test/panel-data.test.mts` | todoDoneItem label + actionsForDoneTodo | 5 |
| `README.md`, `AGENTS.md`, `package.json` | auto-prune + Done tab + /todo done docs; version 0.3.1 | 6 |

---

## Task 1: Rich prune result (`pruneTodos` returns `items` + `ageDays`)

**Files:**
- Modify: `src/archive.ts` (`PruneResult` gains `items`; `pruneTodos` populates it from moved todos' `closedAt`)
- Modify: `test/todo-archive.test.mts` (rich-result assertions)

**Interfaces:**
- Produces: `PruneResult { moved: number; ids: string[]; items: { id: string; status: "done"|"cancelled"; title: string; ageDays: number }[] }`. Later tasks (3, 4) format `items` into the rich output/notify.

- [ ] **Step 1: Write the failing test — append to `test/todo-archive.test.mts`**

```ts
// --- pruneTodos rich result (items + ageDays) ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-prune-rich-"));
  process.env.TODO_DIR = dir;
  const { pruneTodos, loadArchive } = await import("../src/archive.ts");
  const { addTodo, completeTodo, deleteTodo } = await import("../src/todo-store.ts");
  const old = addTodo({ title: "old done", notes: "x" }); completeTodo(old.id);
  const fresh = addTodo({ title: "fresh done", notes: "y" }); completeTodo(fresh.id);
  const cancelled = addTodo({ title: "cancelled old", notes: "z" }); deleteTodo(cancelled.id);
  // backdate the closed todos: old → 30d, cancelled → 30d, fresh → now
  const live = JSON.parse(readFileSync(join(dir, "todo.json"), "utf8"));
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  for (const t of live.todos) {
    if (t.id === old.id || t.id === cancelled.id) { t.closedAt = thirtyDaysAgo; t.updatedAt = thirtyDaysAgo; }
  }
  writeFileSync(join(dir, "todo.json"), JSON.stringify(live, null, 2), "utf8");
  const res = pruneTodos({ ageDays: 7 });
  ok("rich: moved 2 (old done + old cancelled; fresh stays)", res.moved === 2);
  ok("rich: items length matches moved", res.items.length === res.moved);
  ok("rich: items have title", res.items.every((i) => typeof i.title === "string" && i.title.length > 0));
  ok("rich: items have status done|cancelled", res.items.every((i) => i.status === "done" || i.status === "cancelled"));
  ok("rich: old done ageDays ~30", res.items.find((i) => i.id === old.id)!.ageDays >= 29 && res.items.find((i) => i.id === old.id)!.ageDays <= 31);
  ok("rich: ids still present (back-compat)", res.ids.length === res.moved);
  // fresh done (<7d) stays in live
  process.env.TODO_DIR = dir;
  const { loadStore } = await import("../src/todo-store.ts");
  ok("rich: fresh done stays in live", loadStore().todos.some((t) => t.id === fresh.id));
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}
```

Ensure `readFileSync`, `writeFileSync` are imported at the top of `test/todo-archive.test.mts` (they are, from prior work).

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/todo-archive.test.mts`
Expected: FAIL — `res.items` is undefined (pruneTodos doesn't return items yet).

- [ ] **Step 3: Implement — extend `PruneResult` + populate `items` in `src/archive.ts`**

Change the `PruneResult` interface:

```ts
export interface PruneItem {
  id: string;
  status: "done" | "cancelled";
  title: string;
  ageDays: number;
}

export interface PruneResult {
  moved: number;
  ids: string[];
  items: PruneItem[];
}
```

In `pruneTodos`, after building `moved: Todo[]`, compute items. Replace the final `return { moved: moved.length, ids: moved.map((t) => t.id) };` (and the early `return { moved: 0, ids: [] }`) — the early return becomes `return { moved: 0, ids: [], items: [] };` and the success return:

```ts
  const items: PruneItem[] = moved.map((t) => ({
    id: t.id,
    status: t.status as "done" | "cancelled",
    title: t.title,
    ageDays: t.closedAt ? Math.floor((Date.now() - Date.parse(t.closedAt)) / 86400_000) : 0,
  }));
  return { moved: moved.length, ids: moved.map((t) => t.id), items };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/todo-archive.test.mts`
Expected: PASS (all prior cases + the new rich-result case).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all 8 suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/archive.ts test/todo-archive.test.mts
git commit -m "feat(prune): rich result — pruneTodos returns items (id+status+title+ageDays)

PruneResult gains items[] (always populated; callers that only need
{moved, ids} ignore it — resolves spec §12 toward always-rich). ageDays
computed from closedAt. Used next by the extension's prune output + the
auto-prune notify. Back-compat: moved + ids unchanged."
```

---

## Task 2: `listDoneUnified` — unified Done listing (store layer)

**Files:**
- Modify: `src/archive.ts` (new `DoneItem` interface + `listDoneUnified(filter)`)
- Modify: `test/todo-archive.test.mts` (unified-listing assertions)

**Interfaces:**
- Produces: `DoneItem extends Todo { location: "live"|"archive"; archivedAt: string|null }`; `listDoneUnified(filter): DoneItem[]`. Consumed by Task 3 (tool) + Task 5 (panel).

- [ ] **Step 1: Write the failing test — append to `test/todo-archive.test.mts`**

```ts
// --- listDoneUnified: live done + archived done, excludes cancelled, sorted newest-closed first ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-done-unified-"));
  process.env.TODO_DIR = dir;
  const { listDoneUnified, saveArchive } = await import("../src/archive.ts");
  const { addTodo, completeTodo, deleteTodo, loadStore } = await import("../src/todo-store.ts");
  // live done: recent (today) + older
  const liveRecent = addTodo({ title: "live recent done", notes: "lr" }); completeTodo(liveRecent.id);
  const liveOld = addTodo({ title: "live older done", notes: "lo" }); completeTodo(liveOld.id);
  // backdate liveOld closedAt to 10d ago
  const st = loadStore();
  const t = st.todos.find((x) => x.id === liveOld.id)!;
  const tenAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  t.closedAt = tenAgo; t.updatedAt = tenAgo;
  const { saveStore } = await import("../src/todo-store.ts");
  saveStore(st);
  // archived done + archived cancelled
  const archDone: any = { id: "td-arch-d", title: "archived done old", notes: "", project: "pi", tags: [], priority: "med", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: new Date(Date.now() - 40 * 86400_000).toISOString() };
  const archCancelled: any = { id: "td-arch-c", title: "archived cancelled", notes: "", project: "", tags: [], priority: "med", status: "cancelled", source: "", createdAt: "x", updatedAt: "x", closedAt: new Date(Date.now() - 40 * 86400_000).toISOString() };
  saveArchive({ version: 3, updatedAt: "x", todos: [archDone, archCancelled] });
  // live cancelled (should be EXCLUDED from Done view)
  const liveCancelled = addTodo({ title: "live cancelled", notes: "" }); deleteTodo(liveCancelled.id);

  const all = listDoneUnified({});
  ok("unified: 3 done (live recent + live older + archived done)", all.length === 3);
  ok("unified: excludes cancelled (live + archived)", !all.some((d) => d.status === "cancelled"));
  ok("unified: live done tagged location live", all.filter((d) => d.location === "live").length === 2);
  ok("unified: archived done tagged location archive", all.filter((d) => d.location === "archive").length === 1);
  // sorted newest-closed first: liveRecent (today) > liveOld (10d) > archDone (40d)
  eq("unified: sorted newest-closed first", all[0]!.id, liveRecent.id);
  eq("unified: oldest last", all[2]!.id, "td-arch-d");
  // text filter matches title OR notes
  const byNotes = listDoneUnified({ text: "lr" });
  ok("unified: text filter matches notes", byNotes.length === 1 && byNotes[0]!.id === liveRecent.id);
  // project filter
  const byProj = listDoneUnified({ project: "pi" });
  ok("unified: project filter", byProj.every((d) => d.project === "pi"));
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/todo-archive.test.mts`
Expected: FAIL — `listDoneUnified` is not exported.

- [ ] **Step 3: Implement `listDoneUnified` in `src/archive.ts`**

Add the interface + function (after `listArchived`):

```ts
export interface DoneItem extends Todo {
  location: "live" | "archive";
  archivedAt: string | null;
}

export interface DoneFilter {
  text?: string;       // title OR notes substring (case-insensitive)
  project?: string;
  since?: string;      // closedAt >= since
  before?: string;     // closedAt < before
  limit?: number;      // default 50
  page?: number;       // default 1
}

/** Unified done todos across the live store + the archive. Excludes cancelled
 *  (Done = finished work). Sorted newest-closed first. */
export function listDoneUnified(filter: DoneFilter = {}): DoneItem[] {
  const live = loadStore().todos.filter((t) => t.status === "done");
  const arch = loadArchive().todos.filter((t) => t.status === "done");
  const items: DoneItem[] = [
    ...live.map((t) => ({ ...t, location: "live" as const, archivedAt: null })),
    ...arch.map((t) => ({ ...t, location: "archive" as const, archivedAt: t.closedAt })),
  ];
  let out = items;
  if (filter.text) {
    const q = filter.text.toLowerCase();
    out = out.filter((t) => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
  }
  if (filter.project) out = out.filter((t) => t.project === filter.project);
  if (filter.since) out = out.filter((t) => (t.closedAt ?? t.updatedAt) >= (filter.since as string));
  if (filter.before) out = out.filter((t) => (t.closedAt ?? t.updatedAt) < (filter.before as string));
  const sorted = out.slice().sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
  const limit = filter.limit ?? 50;
  const page = filter.page ?? 1;
  const start = (page - 1) * limit;
  return sorted.slice(start, start + limit);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/todo-archive.test.mts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all 8 suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/archive.ts test/todo-archive.test.mts
git commit -m "feat(done): listDoneUnified — unified done listing across live + archive

DoneItem extends Todo with location (live|archive) + archivedAt.
listDoneUnified merges live done + archived done (EXCLUDES cancelled —
Done = finished work), sorted newest-closed first, filterable by
text (title|notes) / project / since / before / limit / page. Consumed
next by the todo list status:done tool, /todo done slash, and the
panel Done tab."
```

---

## Task 3: Extension tool surface — `todo list status:done` unified + rich prune output + `/todo done`

**Files:**
- Modify: `extensions/todo.ts`

**Interfaces:**
- Consumes: `listDoneUnified`, `PruneItem` from `src/archive.ts` (Tasks 1, 2).
- Produces: the updated `todo` tool + `/todo` slash. Manual-gate (node --check + RECTOR QA).

- [ ] **Step 1: Import `listDoneUnified` + a `fmtDone` helper**

At the top, add to the `../src/archive` import:

```ts
import { pruneTodos, restoreTodo, listArchived, archiveSummary, listDoneUnified } from "../src/archive";
```

Add a `fmtDone` helper near `fmt`/`fmtFull`:

```ts
function fmtDone(d: ReturnType<typeof listDoneUnified>[number]): string {
  const tag = d.project ? ` (${d.project})` : "";
  const loc = d.location === "archive" && d.archivedAt
    ? ` [archived ${d.archivedAt.slice(0, 10)}]`
    : (() => {
        const days = d.closedAt ? Math.floor((Date.now() - Date.parse(d.closedAt)) / 86400_000) : 0;
        return ` [live ${days}d]`;
      })();
  return `- [${d.id}] (done)${tag} ${d.title}${loc}`;
}
```

- [ ] **Step 2: Route `todo list status:done` to the unified listing**

In the `list` case, **before** the existing `listTodos` branch, add a done-routing branch:

```ts
          case "list": {
            if (params.status === "done" && !params.archived) {
              const items = listDoneUnified({
                text: params.text,
                project: params.projectFilter,
                since: params.since,
                before: params.before,
                limit: params.limit,
                page: params.page,
              });
              if (items.length === 0) {
                return { content: [{ type: "text" as const, text: "No done TODOs (live or archive)." }] };
              }
              return { content: [{ type: "text" as const, text: `Done (${items.length}):\n${items.map(fmtDone).join("\n")}` }] };
            }
            if (params.archived) {
              // ... existing archive branch unchanged
```

(Insert the done-routing `if` right after `case "list": {` and before `if (params.archived) {`. Keep the existing archive + live branches untouched for other statuses.)

- [ ] **Step 3: Rich output for the manual `prune` tool case**

Replace the non-hard `prune` return (the `return { content: ... Pruned N todo... }` line) with a rich format:

```ts
            const res = pruneTodos({ ageDays: params.ageDays, all: params.all });
            if (res.moved === 0) {
              return { content: [{ type: "text" as const, text: "Nothing to prune (no stale done/cancelled)." }] };
            }
            const lines = res.items.map((i) => `  [${i.id}] ${i.status}  ${i.title}  (was ${i.ageDays}d old)`);
            return { content: [{ type: "text" as const, text: `Pruned ${res.moved} todo${res.moved === 1 ? "" : "s"} to archive:\n${lines.join("\n")}\nUndo any with: todo restore <id>` }] };
```

- [ ] **Step 4: `/todo done` slash subcommand + rich `/todo prune` slash output**

In the slash `handler`, add a `done` subcommand (after the `archive` subcommand block):

```ts
        if (sub === "done") {
          const { listDoneUnified } = await import("../src/archive.ts");
          const items = listDoneUnified({ text: rest.join(" ").trim() || undefined, limit: 100 });
          const msg = items.length ? `Done (${items.length}):\n${items.map(fmtDone).join("\n")}` : "(no done TODOs)";
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          return;
        }
```

And replace the slash `prune` (non-hard) notify with the rich format (mirror Step 3):

```ts
          const all = rest.includes("--all");
          const res = pruneTodos({ all });
          if (ctx.hasUI) {
            const msg = res.moved === 0
              ? "Nothing to prune."
              : `Pruned ${res.moved} to archive:\n${res.items.map((i) => `  [${i.id}] ${i.title} (${i.ageDays}d)`).join("\n")}\nUndo: todo restore <id>`;
            ctx.ui.notify(msg, "info");
          }
          return;
```

Add `done` to the slash `description` string (`/todo done`).

- [ ] **Step 5: Update `promptGuidelines`** — add auto-prune awareness + `/todo done`

Add two guidelines (keep the rest):

```ts
      "Done/cancelled todos older than the prune age (default 7d) auto-archive on session start — you'll see a notify; they're reversible via todo restore <id>. Use /todo done or todo list status:'done' to see all finished work (live + archived).",
      "Use todo (action:'prune') only for an explicit user prune (e.g. prune --all to move fresh done too); routine pruning is automatic.",
```

- [ ] **Step 6: Verify it parses**

Run: `node --check extensions/todo.ts`
Expected: no output (success).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all 8 suites PASS (extension isn't loaded by suites).

- [ ] **Step 8: Commit**

```bash
git add extensions/todo.ts
git commit -m "feat(ext): todo list status:done unified + /todo done + rich prune output

todo list status:'done' now returns the unified done set (live + archive,
location-tagged) via listDoneUnified. Manual prune (tool + /todo prune slash)
emits a rich result (id+status+title+ageDays + restore hint). New /todo done
slash. Prompt guidelines teach the auto-prune-on-session-start behavior +
/todo done. Extension is manual-gate (node --check + RECTOR QA)."
```

---

## Task 4: Auto-prune on `session_start` (`src/auto-prune.ts` + extension wiring)

**Files:**
- Create: `src/auto-prune.ts` (`autoPruneOnSessionStart(): PruneResult | null`)
- Modify: `extensions/todo.ts` (`session_start` handler calls it + rich notify)
- Create: `test/todo-auto-prune.test.mts`

**Interfaces:**
- Consumes: `pruneTodos` (Task 1), `loadConfig`.
- Produces: `autoPruneOnSessionStart()` — returns the `PruneResult` if anything moved, else `null`.

- [ ] **Step 1: Write the failing tests — `test/todo-auto-prune.test.mts`**

```ts
// Auto-prune on session_start — the deterministic age-gated prune.
// Run: node test/todo-auto-prune.test.mts
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

const { autoPruneOnSessionStart } = await import("../src/auto-prune.ts");

function seed(dir: string) {
  process.env.TODO_DIR = dir;
  return dir;
}

// Case 1: stale done (>7d) + stale cancelled (>7d) → auto-pruned; fresh done + open untouched
{
  const dir = seed(mkdtempSync(join(tmpdir(), "armory-ap1-")));
  const { addTodo, completeTodo, deleteTodo, loadStore } = await import("../src/todo-store.ts");
  const { loadArchive } = await import("../src/archive.ts");
  const staleDone = addTodo({ title: "stale done", notes: "" }); completeTodo(staleDone.id);
  const staleCancelled = addTodo({ title: "stale cancelled", notes: "" }); deleteTodo(staleCancelled.id);
  const freshDone = addTodo({ title: "fresh done", notes: "" }); completeTodo(freshDone.id);
  const open = addTodo({ title: "open", notes: "" });
  // backdate stale to 30d ago
  const st = loadStore();
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  for (const t of st.todos) {
    if (t.id === staleDone.id || t.id === staleCancelled.id) { t.closedAt = thirtyAgo; t.updatedAt = thirtyAgo; }
  }
  const { saveStore } = await import("../src/todo-store.ts");
  saveStore(st);
  const res = autoPruneOnSessionStart();
  ok("ap: returns result when something moved", res !== null);
  eq("ap: moved 2", res!.moved, 2);
  ok("ap: rich items present", res!.items.length === 2);
  ok("ap: stale done moved to archive", loadArchive().todos.some((t) => t.id === staleDone.id));
  ok("ap: stale cancelled moved to archive", loadArchive().todos.some((t) => t.id === staleCancelled.id));
  const live = loadStore();
  ok("ap: fresh done stays in live", live.todos.some((t) => t.id === freshDone.id));
  ok("ap: open untouched", live.todos.some((t) => t.id === open.id));
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// Case 2: nothing stale → null, no-op
{
  const dir = seed(mkdtempSync(join(tmpdir(), "armory-ap2-")));
  const { addTodo, completeTodo, loadStore } = await import("../src/todo-store.ts");
  addTodo({ title: "fresh done today", notes: "" }); // will complete below
  const st = loadStore();
  const t = st.todos[0]!; t.status = "done"; t.closedAt = new Date().toISOString();
  const { saveStore } = await import("../src/todo-store.ts");
  saveStore(st);
  const res = autoPruneOnSessionStart();
  eq("ap: null when nothing stale", res, null);
  ok("ap: live unchanged when no-op", loadStore().todos.length === 1);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// Case 3: idempotent — second call is a no-op (already pruned)
{
  const dir = seed(mkdtempSync(join(tmpdir(), "armory-ap3-")));
  const { addTodo, completeTodo, loadStore, saveStore } = await import("../src/todo-store.ts");
  const d = addTodo({ title: "stale", notes: "" }); completeTodo(d.id);
  const st = loadStore();
  const t = st.todos.find((x) => x.id === d.id)!;
  t.closedAt = new Date(Date.now() - 30 * 86400_000).toISOString();
  saveStore(st);
  const first = autoPruneOnSessionStart();
  eq("ap: first moved 1", first!.moved, 1);
  const second = autoPruneOnSessionStart();
  eq("ap: second is null (idempotent)", second, null);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// Case 4: respects config defaultAgeDays (set to 1d; a 3d-old done prunes)
{
  const dir = seed(mkdtempSync(join(tmpdir(), "armory-ap4-")));
  const { addTodo, completeTodo, loadStore, saveStore } = await import("../src/todo-store.ts");
  const { loadConfig, saveConfig } = await import("../src/config.ts");
  const cfg = loadConfig(); cfg.prune.defaultAgeDays = 1; saveConfig(cfg);
  const d = addTodo({ title: "3d done", notes: "" }); completeTodo(d.id);
  const st = loadStore();
  const t = st.todos.find((x) => x.id === d.id)!;
  t.closedAt = new Date(Date.now() - 3 * 86400_000).toISOString();
  saveStore(st);
  const res = autoPruneOnSessionStart();
  eq("ap: 3d-old prunes when ageDays=1", res!.moved, 1);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/todo-auto-prune.test.mts`
Expected: FAIL — `autoPruneOnSessionStart` not exported.

- [ ] **Step 3: Implement `src/auto-prune.ts`**

```ts
// Auto-prune on session_start — the deterministic age-gated prune that runs
// when the extension loads. Wraps pruneTodos with the config default age; never
// --all (fresh done <defaultAgeDays stays). Returns the rich PruneResult if
// anything moved, else null (caller stays silent). Reversible via restore.

import { pruneTodos, type PruneResult } from "./archive.ts";
import { loadConfig } from "./config.ts";

/** Prune stale done/cancelled (older than config.prune.defaultAgeDays) on
 *  session start. Returns the PruneResult if anything moved, else null. */
export function autoPruneOnSessionStart(): PruneResult | null {
  const config = loadConfig();
  const res = pruneTodos({ ageDays: config.prune.defaultAgeDays });
  return res.moved > 0 ? res : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/todo-auto-prune.test.mts`
Expected: PASS.

- [ ] **Step 5: Wire into the extension `session_start` handler**

In `extensions/todo.ts`, add the import + rewrite the `session_start` body. Import:

```ts
import { autoPruneOnSessionStart } from "../src/auto-prune";
```

Replace the `session_start` handler body:

```ts
  pi.on("session_start", async (_event, ctx) => {
    try {
      let autoMsg = "";
      try {
        const ap = autoPruneOnSessionStart();
        if (ap) {
          const lines = ap.items.map((i) => `  [${i.id}] ${i.status}  ${i.title}`);
          autoMsg = ` · auto-pruned ${ap.moved} stale done (>${loadConfig().prune.defaultAgeDays}d):\n${lines.join("\n")}\nUndo any with: todo restore <id>`;
        }
      } catch {
        // auto-prune optional — don't crash the session notify
      }
      const open = listTodos();
      let msg = `armory-todo: ${open.length} open TODO${open.length === 1 ? "" : "s"}${autoMsg}`;
      try {
        const report = healthReport();
        if (report.flags.length > 0) {
          msg += `${autoMsg ? "\n" : " "}` + `⚠ ${report.flags.length} bloat signal${report.flags.length === 1 ? "" : "s"} (run /todo health)`;
        }
      } catch {
        // health optional
      }
      if (ctx.hasUI) ctx.ui.notify(msg, "info");
    } catch {
      // store unavailable — never crash the session
    }
  });
```

Add `loadConfig` to the imports from `../src/config` (if not already imported — it's used by the panel; the extension may not import it directly. Check + add):

```ts
import { loadConfig } from "../src/config";
```

- [ ] **Step 6: Verify it parses + add to the test loop**

Run:
```bash
node --check extensions/todo.ts
node --check src/auto-prune.ts
```
Expected: no output (success).

Add `todo-auto-prune` to the `npm test` loop in `package.json` (before `panel-data`):

```text
for t in todo-store todo-title-notes todo-archive todo-config todo-migrate todo-health todo-hard-prune todo-auto-prune panel-data; do node test/$t.test.mts || exit 1; done
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all 9 suites PASS.

- [ ] **Step 8: Commit**

```bash
git add src/auto-prune.ts extensions/todo.ts package.json test/todo-auto-prune.test.mts
git commit -m "feat(auto-prune): age-gated prune on session_start + rich notify

New src/auto-prune.ts: autoPruneOnSessionStart() wraps pruneTodos with the
config default age (never --all; fresh done stays). Returns the rich
PruneResult if anything moved, else null. The extension session_start
handler calls it + emits a rich notify (ids+status+title + restore hint)
when something was pruned, silent otherwise. Injection contract unchanged
(only open+in_progress injected). New todo-auto-prune.test.mts (4 cases:
stale moves + fresh stays, no-op when clean, idempotent, respects config
age). npm test loop gains todo-auto-prune (8 -> 9 suites)."
```

---

## Task 5: Panel `Done` box tab

**Files:**
- Modify: `src/panel-data.ts` (`todoDoneItem` + `actionsForDoneTodo`)
- Modify: `src/panel.ts` (`BOXES` + `done` tab; `refreshList` Done branch; done-row action submenu)
- Modify: `test/panel-data.test.mts` (`todoDoneItem` + `actionsForDoneTodo`)

**Interfaces:**
- Consumes: `listDoneUnified`, `DoneItem` (Task 2).
- Produces: `todoDoneItem(d: DoneItem): SelectItem`; `actionsForDoneTodo(d: DoneItem): {label, action}[]`.

- [ ] **Step 1: Write the failing tests — append to `test/panel-data.test.mts`**

```ts
// --- todoDoneItem: location-tagged label ---
const { todoDoneItem, actionsForDoneTodo } = await import("../src/panel-data.ts");
import type { DoneItem } from "../src/archive.ts";

const liveDone: DoneItem = { id: "td-d1", title: "finished today", notes: "", project: "pi", tags: [], priority: "med", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: new Date().toISOString(), location: "live", archivedAt: null };
const archDone: DoneItem = { id: "td-d2", title: "old finished", notes: "", project: "", tags: [], priority: "low", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: "2026-07-10T00:00:00Z", location: "archive", archivedAt: "2026-07-10T00:00:00Z" };

const li = todoDoneItem(liveDone);
ok("doneItem: label has title", li.label.includes("finished today"));
ok("doneItem: live tagged [live Nd]", /\[live \d+d\]/.test(li.label));

const ai = todoDoneItem(archDone);
ok("doneItem: archive tagged [archived YYYY-MM-DD]", ai.label.includes("[archived 2026-07-10]"));

// --- actionsForDoneTodo ---
ok("done actions: View detail (live)", actionsForDoneTodo(liveDone).some((a) => a.action === "view"));
ok("done actions: no Restore for live", !actionsForDoneTodo(liveDone).some((a) => a.action === "restore"));
ok("done actions: Restore for archived", actionsForDoneTodo(archDone).some((a) => a.action === "restore"));
ok("done actions: no Delete for done", !actionsForDoneTodo(liveDone).some((a) => a.action === "delete"));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node test/panel-data.test.mts`
Expected: FAIL — `todoDoneItem`/`actionsForDoneTodo` not exported.

- [ ] **Step 3: Implement in `src/panel-data.ts`**

```ts
import type { DoneItem } from "./archive.ts";

/** Format a done todo (live or archived) as a SelectList item with a
 *  location tag: "[live Nd]" or "[archived YYYY-MM-DD]". */
export function todoDoneItem(d: DoneItem): SelectItem {
  const proj = d.project ? ` (${d.project})` : "";
  const loc = d.location === "archive" && d.archivedAt
    ? ` [archived ${d.archivedAt.slice(0, 10)}]`
    : ` [live ${d.closedAt ? Math.floor((Date.now() - Date.parse(d.closedAt)) / 86400_000) : 0}d]`;
  return { value: d.id, label: `[${d.id}] (done)${proj}${loc} ${d.title}` };
}

/** Actions for a done todo: View detail always; Restore only if archived. */
export function actionsForDoneTodo(d: DoneItem): { label: string; action: string }[] {
  const acts: { label: string; action: string }[] = [{ label: "View detail", action: "view" }];
  if (d.location === "archive") acts.push({ label: "Restore (from archive)", action: "restore" });
  return acts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/panel-data.test.mts`
Expected: PASS.

- [ ] **Step 5: Wire the `Done` tab into `src/panel.ts`**

Update `BOXES`:

```ts
const BOXES: Box[] = ["active", "parked", "done", "archive", "config"];
```

Update the `Box` type: `export type Box = "active" | "parked" | "done" | "archive" | "config";`

Add imports: `listDoneUnified` from `./archive.ts`, `todoDoneItem, actionsForDoneTodo` from `./panel-data.ts`, `restoreTodo` (already imported).

In `refreshList`, add a `done` branch (after the `parked` branch, before the `archive` branch):

```ts
    } else if (this.currentBox === "done") {
      const items = listDoneUnified({ text: filter || undefined, limit: 50 });
      this.setSelectItems(items.map(todoDoneItem));
    } else if (this.currentBox === "archive") {
```

In `onItemSelect`, the done-box rows have plain ids (no `project:`/`month:`/`total` prefix) → they fall through to `openActionSubmenu(item.value)`. But the action set differs for done. Add a done-aware path: in `openActionSubmenu`, detect the done box and use `actionsForDoneTodo`. Simplest: pass the current box to `openActionSubmenu` and branch. Change `openActionSubmenu(id: string)` to look up the todo via `listDoneUnified` when `this.currentBox === "done"`, and build the action list with `actionsForDoneTodo`:

```ts
  private openActionSubmenu(id: string): void {
    let acts: { label: string; action: string }[];
    let todoExists = true;
    if (this.currentBox === "done") {
      const d = listDoneUnified({}).find((x) => x.id === id);
      if (!d) { this.onNotify("Done todo not found.", "info"); return; }
      acts = actionsForDoneTodo(d);
    } else {
      const all = listTodos({ status: "all", limit: 200 });
      const todo = all.find((t) => t.id === id);
      if (!todo) { this.onNotify("Todo not found in the live store (archive restore: use the archive box).", "info"); return; }
      acts = [{ label: "View detail", action: "view" }, ...actionsForTodo(todo)];
    }
    const items: SelectItem[] = acts.map((a) => ({ value: a.action, label: a.label }));
    this.actionList = new SelectList(items, 8, { /* same opts as before */ });
    this.actionList.onSelect = (a) => this.executeAction(id, a.value);
    this.actionList.onCancel = () => { this.actionMode = false; this.actionList = null; this.renderShell(); };
    this.actionMode = true;
    this.renderShell();
  }
```

(Keep the existing `SelectList` options verbatim — only the `acts` source changes.)

`executeAction` already handles `view` (Task 5 of v0.3.0) + `restore` (calls `restoreTodo(id)`). The done-box `restore` reuses the existing `case "restore": restoreTodo(id); ...`. No new case needed — confirm `executeAction`'s `restore` case exists + works for done-box rows. (It does from v0.3.0.) After a restore from the done box, `refreshList()` re-pulls `listDoneUnified` (the restored todo is now `open` in live → no longer in the done set) and the list updates. Good.

- [ ] **Step 6: Verify both files parse**

Run:
```bash
node --check src/panel.ts
node --check src/panel-data.ts
```
Expected: no output (success).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all 9 suites PASS.

- [ ] **Step 8: Commit**

```bash
git add src/panel-data.ts src/panel.ts test/panel-data.test.mts
git commit -m "feat(panel): Done box tab — unified done view (live + archived)

New 5th box tab 'Done' shows status:done todos unified across live + archive
(excludes cancelled), location-tagged ([live Nd] / [archived YYYY-MM-DD]),
sorted newest-closed first, filterable. todoDoneItem + actionsForDoneTodo
helpers (View detail always; Restore only if archived; no Delete for done).
Archive tab unchanged (sealed vault: done + cancelled). BOXES -> 5 tabs."
```

---

## Task 6: Docs + version bump + ship

**Files:**
- Modify: `package.json` (`version: 0.3.1`)
- Modify: `README.md` (auto-prune, Done tab, `/todo done`, test count)
- Modify: `AGENTS.md` (modules + suites + features)

- [ ] **Step 1: Bump version**

```bash
sed -i '' 's/"version": "0.3.0"/"version": "0.3.1"/' package.json
```

- [ ] **Step 2: Update README**

- Lifecycle section: add a note that done/cancelled auto-archive on session_start after `defaultAgeDays` (reversible).
- Slash list: add `/todo done`.
- Panel section: add the `Done` tab to the box-tabs line + the location tags + done-row actions.
- Test count line: `npm test (220/220 across 8 suites)` → the new count (run `npm test` to get it; 9 suites now).
- (Full README revamp is a separate tracked TODO `td-mru4r65krntwz0` — after v0.3.1 ships; here just add the v0.3.1 facts.)

- [ ] **Step 3: Update AGENTS.md**

- Structure: `test/` 8 → 9 suites (add `todo-auto-prune`); `src/` add `auto-prune (session_start age-gated prune)`.
- Common Commands: add `node test/todo-auto-prune.test.mts` + update the total count.
- Notes: add the auto-prune + unified Done view bullets.

- [ ] **Step 4: Run the full suite + syntax checks**

Run:
```bash
npm test
for f in src/*.ts extensions/todo.ts; do node --check "$f" || echo "FAIL $f"; done
```
Expected: all 9 suites PASS; all `--check` silent.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md AGENTS.md
git commit -m "docs(v0.3.1): auto-prune + Done tab + /todo done, version bump"
```

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin feat/auto-prune-done-view
gh pr create --base main --head feat/auto-prune-done-view \
  --title "v0.3.1 — auto-prune on session_start + unified Done view" \
  --body-file /tmp/v031-pr-body.md   # write the body to a file first (backticks break inline heredoc)
```

(PR body: summary of auto-prune + rich result + unified Done + Done tab + injection unchanged; tests 9 suites; QA gate note. Write to `/tmp/v031-pr-body.md` then `--body-file`.)

- [ ] **Step 7: RECTOR QA gate (manual — do NOT merge until sign-off)**

Local install + restart pi, verify:
1. **Auto-prune:** seed a done todo >7d old in the live store, restart pi → startup notify shows `auto-pruned 1 stale done (>7d): ... Undo with: todo restore <id>`; the todo is in the archive; a fresh done (<7d) stays in live.
2. **`/todo done`** → unified list (live + archived done, location-tagged).
3. **`todo list status:'done'`** (tool) → same unified list.
4. **`/todo` panel** → `Done` tab shows unified done; View detail works; Restore-from-archive works (archived done → back to live as open); Archive tab unchanged.
5. **Manual `/todo prune`** → rich output (id+title+age + restore hint).
6. **Injection unchanged** → `## Open TODOs` still shows only open+in_progress (title + `•`).
7. **`/todo health`** → unchanged (+notes-bytes line from v0.3.0).

- [ ] **Step 8: After QA sign-off — merge + tag**

```bash
gh pr merge <N> --merge --delete-branch
git checkout main && git pull
git tag -am "v0.3.1 — auto-prune + unified Done view" v0.3.1
git push origin v0.3.1   # triggers release.yml → npm publish + GitHub Release (auto)
npm view @getpipher/armory-todo version   # verify 0.3.1
```

- [ ] **Step 9: Post-ship**

- Mark the spec `shipped` in `docs/superpowers/specs/2026-07-21-auto-prune-done-view-design.md`.
- Record a `v0.3.1-shipped.md` memory (gotchas: auto-prune notify on every /reload repeats — acceptable; the open `detail` flag question resolved → always-rich).
- Flip RECTOR's settings back to `npm:@getpipher/armory-todo@0.3.1` (remove local-path if used for QA).
- **Then action the parked README-revamp TODO `td-mru4r65krntwz0`** (start with the hero section).

---

## Self-Review (run after writing the plan)

**Spec coverage:**
- §5 auto-prune (session_start, age-gated, never --all, silent-when-clean, idempotent, rich notify) → Task 4 ✅
- §6 rich prune result (items + ageDays, auto + manual) → Task 1 (store) + Task 3 (ext output) ✅
- §7 unified Done listing (listDoneUnified, list status:done unified, /todo done) → Task 2 (store) + Task 3 (tool/slash) ✅
- §8 panel Done tab (5 tabs, location tags, View detail + Restore-from-archive, Archive unchanged) → Task 5 ✅
- §9 injection contract unchanged → Global Constraints + Task 4 notes (no renderOpenBlock change) ✅
- §10 tests (new todo-auto-prune + extend archive/panel-data) → Tasks 1, 2, 4, 5 ✅
- §11 branch + ship → Task 6 ✅

**Placeholder scan:** none — every step has exact code or commands.

**Type consistency:** `PruneResult.items: PruneItem[]` (Task 1) ← consumed by Task 3 + 4. `DoneItem` + `listDoneUnified` (Task 2) ← consumed by Task 3 + 5. `autoPruneOnSessionStart(): PruneResult | null` (Task 4) ← consumed by the extension. `todoDoneItem` + `actionsForDoneTodo` (Task 5) ← consumed by panel. Names match across tasks.

**One note:** Task 5 Step 5's `openActionSubmenu` rewrite reuses the existing `SelectList` options — at implementation, copy the option object verbatim from the current `openActionSubmenu` (don't retype it; the plan elides it with a comment for brevity).