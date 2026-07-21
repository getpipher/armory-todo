# Workstream v0.3.1 — auto-prune on session_start + unified `Done` view

**Date:** 2026-07-21
**Status:** Design approved → pending implementation plan
**Branch:** `feat/auto-prune-done-view` off `main`
**Predecessor:** v0.3.0 (title + notes split), shipped 2026-07-21 (PR #4)
**Target ship:** v0.3.1, auto-published via `release.yml` on `v0.3.1` tag (now also creates a GitHub Release)

---

## 1. Problem

v0.3.0 split title/notes and fixed per-todo injection bloat, but two friction points remain in the *lifecycle* of finished work:

1. **Prune is 100% manual.** Done/cancelled todos sit in the live `todo.json` forever until someone runs `/todo prune`. On a busy stretch they pile up; the `session_start` bloat nudge only *suggests* pruning — it never does it. The user is the prune trigger.
2. **"Done" is split across two stores after pruning.** Recent done (<7d) lives in the live store; older done lives in `todo-archive.json`. There's no single "show me my finished work" view — you query live and archive separately. The `/todo` panel's Archive tab shows only the archive file (sealed history: done + cancelled), not recent live done.

## 2. Goals

- **Auto-prune:** done/cancelled todos older than `config.prune.defaultAgeDays` (default 7d) archive *themselves* on `session_start`, without the user asking. Deterministic (the extension does it, not the model remembering to) — but **silent when there's nothing stale**.
- **Transparency:** every prune (auto or manual) reports a **rich result** (ids + titles + age + `restore` hint), so the user is never blind to what moved — especially when the agent auto-pruned without an explicit trigger.
- **Unified `Done` view:** one command + one panel tab to see all finished work (`status: done`), spanning live (recent) + archive (old), annotated by location, filterable.
- **Preserve the injection contract unchanged:** only `open` + `in_progress` are auto-injected into the prompt. Parked / done / archive are not injected. v0.3.1 does not alter this boundary.

## 3. Non-goals (deferred)

- **`cancelled`-in-live visibility** — a pre-existing gap (cancelled todos <7d are in live but shown in no panel tab). Cancelled shows in the Archive tab once pruned. Separate concern; not addressed here.
- **`prune --all` / `prune --hard`** — unchanged (manual only; `--hard` stays the only irreversible, gated action).
- **Auto-prune of `parked`** — parked is deferred-not-finished, not "done"; auto-prune targets `done`/`cancelled` only (same as manual `prune`).
- **Time-based/scheduled prune outside session_start** — no cron; auto-prune runs only on the `session_start` hook (cold start / resume / fork / reload).

## 4. Decisions log (from brainstorm Q&A)

| # | Question | Decision |
|---|---|---|
| Q1 | Where does "done" live in the `/todo` panel? | **A** — new 5th box tab `Done` (status `done` only, unified live+archive). `done` (status) ≠ `archive` (location) — different axes; `Done` = workflow view, `Archive` = storage vault. |
| Q2 | Auto-prune trigger mechanism | Deterministic on `session_start` (extension code), age-gated (>`defaultAgeDays`), **never `--all`**. Not prompt-driven (the model doesn't have to remember). |
| Q3 | Confirm gate for auto-prune? | No gate — reversible + age-gated, not destructive. The `--hard` gate stays untouched. |
| Q4 | Visibility when prune runs | Rich result (ids + titles + age + `restore` hint) for BOTH auto and manual prune. |
| Q5 | Unified `done` listing | `todo list status:done` spans live+archive in one call; `/todo done` slash shortcut. |
| Q6 | Injection contract | **Unchanged** — only `open`+`in_progress` injected. Auto-prune moves done→archive (both non-injected); zero injection impact. The Done tab is a panel view only. |

## 5. Auto-prune on `session_start`

### 5.1 Trigger

The extension's existing `session_start` handler (in `extensions/todo.ts`) currently: loads open todos, computes `healthReport()`, and notifies `armory-todo: N open TODOs` (+ a `⚠ N bloat signals` suffix if flags). v0.3.1 inserts an **auto-prune step** before the notify:

1. Load the live store.
2. Compute the set of done/cancelled todos with `closedAt` older than `config.prune.defaultAgeDays` (default 7d) — i.e. exactly what `pruneTodos({})` (age-gated, no `--all`) would move.
3. **If that set is non-empty → call `pruneTodos({})`** (age-gated; **never `--all`**) and capture the moved ids + todos.
4. Notify once, with the rich format (§6).
5. **If empty → skip** (just the normal `N open TODOs` notify; no prune noise).

This runs on every `session_start` (cold start / resume / fork / `/reload`). Because it's age-gated, it's a no-op on a clean store — no churn, no prune spam. Idempotent: once pruned, the todos are in the archive; the next start sees nothing stale.

### 5.2 Why deterministic (not prompt-driven)

"Agent thinks" = the agent's *awareness* drives it, but relying on the model to remember to call `prune` every session is fragile. Wiring it into the `session_start` hook makes it **just happen** reliably — the extension acts on the user's behalf at session start, deterministically. The model still *sees* the result (via the notify) and can act on it (e.g. mention it, or `restore` if the user asks). This matches the user's intent ("automatically triggered") without depending on model compliance.

### 5.3 Config

Reuses `config.prune.defaultAgeDays` (7) — already tunable via the Config tab / `todo.config.json`. **No new config key.** A future v0.4.x could add `config.prune.autoOnSessionStart: boolean` to disable auto-prune, but v0.3.1 ships it always-on (age-gated).

### 5.4 Notify format

```
armory-todo: 2 open TODOs · auto-pruned 3 stale done (>7d):
  [td-…] done  armory-todo v0.2.0 — Workstream A shipped…
  [td-…] done  Task 1: Store schema break…
  [td-…] cancelled  QA smoke v0.3.0
Undo any with: todo restore <id>
```

(When nothing was pruned, just `armory-todo: N open TODOs` — unchanged from v0.3.0, optionally + the existing `⚠ bloat` suffix if health flags fire.)

The notify is a **transient `ctx.ui.notify` message**, NOT a system-prompt injection. The `## Open TODOs` prompt block is untouched.

## 6. Rich prune result (auto + manual)

Both the auto-prune (§5) and manual `prune` (tool + `/todo prune` slash) produce the same structured output. New helper in `src/archive.ts`:

```ts
export interface PruneDetail {
  moved: number;
  items: { id: string; status: "done" | "cancelled"; title: string; ageDays: number }[];
}
```

`pruneTodos` gains an optional `detail: true` flag (default false for back-compat) that returns `items` + `ageDays` (computed from `closedAt`). When `detail` is true, the caller (extension) formats:

```
Pruned 3 todos to archive:
  [td-…] done  <title>  (was 9d old)
  [td-…] cancelled  <title>  (was 12d old)
Undo any with: todo restore <id>
```

- **Manual `prune`** (tool + slash): always uses `detail: true` → rich output.
- **Auto-prune** (session_start): uses `detail: true` → rich notify.
- The `--all` path: same rich format (age shown as `(--all)` or the real age; minor).

The existing `PruneResult { moved, ids }` shape stays (back-compat for any caller); `PruneDetail` is additive.

## 7. Unified `Done` listing

### 7.1 Store layer (`src/archive.ts` + `src/todo-store.ts`)

New `listDoneUnified(filter?): DoneItem[]` (in `archive.ts` — it already coordinates live + archive via `loadStore`/`loadArchive`):

```ts
export interface DoneItem extends Todo {
  location: "live" | "archive";
  archivedAt: string | null;  // closedAt for live; closedAt for archive (the prune time ≈ closedAt)
}
```

- Pulls done todos from the live store (`loadStore().todos.filter(status === "done")`) tagged `location: "live"`, plus done todos from the archive (`loadArchive().todos.filter(status === "done")`) tagged `location: "archive"`.
- **Excludes `cancelled`** (Done = finished work; cancelled = abandoned → lives in the Archive tab only).
- Sorts newest-`closedAt` first.
- Filter: `text` (title|notes substring), `project`, `since`, `before`, `limit`, `page` (same shape as `listTodos`/`listArchived` filters).

### 7.2 Tool (`extensions/todo.ts`)

- **`todo list status:done`** now returns the **unified** set (live + archive) via `listDoneUnified`, formatted:
  ```
  - [td-…] done  <title>  [live 3d]
  - [td-…] done  <title>  [archived 2026-07-15]
  ```
  (When `status:done` is set, the `archived` param is ignored — `done` is always unified. Other status values keep current behavior: `archived:true` queries the archive, default queries live.)

### 7.3 Slash (`/todo done`)

New slash subcommand: `/todo done` → prints the unified done list (recent first), same row format as §7.2. `/todo done project:bug-bounty` → filtered.

## 8. `/todo` panel — new `Done` box tab

### 8.1 Tabs

`BOXES` becomes `["active", "parked", "done", "archive", "config"]` (5 tabs).

### 8.2 Done tab content

- Uses `listDoneUnified({ text: filter })` (the panel's filter input searches title|notes across the unified set).
- `todoToItem` rows: `[id] (done) (project) • <title>` + a location tag suffix `[live N]` or `[archived <YYYY-MM-DD>]`. (Add a `todoDoneItem` helper in `panel-data.ts` that extends `todoToItem` with the location tag, or add an optional `location` param to `todoToItem`.)
- Sorted newest-closed first.
- Action submenu on Enter: **View detail** + (if location is archive) **Restore** (brings it back as open). Live done rows offer **View detail** only (no Restore — they are already in the live store; use `todo update <id> status:open` to reopen, or leave as done). No **Delete** for done rows (already finished; deletion/cancel is for open todos).

### 8.3 Archive tab — unchanged

Still the sealed-vault browse view: summary-first (counts by project + month across done + cancelled), drill-down with a filter. Unchanged from v0.3.0.

### 8.4 Footer hint

Update the panel footer to reflect 5 tabs: `↑↓ navigate • enter select/action • tab switch box • esc done`.

## 9. Injection contract (unchanged — explicit)

`renderOpenBlock()` still calls `listTodos()` with the default filter (`status === "open" || status === "in_progress"`). v0.3.1 does NOT touch `renderOpenBlock` or `listTodos`'s default. Therefore:

- Only `open` + `in_progress` are auto-injected (title + `•`, capped 15).
- Parked / done / archive are NOT injected — available via `list`/`get`/panel only.
- Auto-prune moves done (not injected) → archive (not injected): **zero injection impact**.
- The Done tab is a panel view; it does not inject.

The only new thing the *agent* sees at session start is the transient `ctx.ui.notify` (§5.4), not a system-prompt change.

## 10. Tests

Baseline: 220 across 8 suites. Target: ~240+.

### 10.1 New suite `test/todo-auto-prune.test.mts`
- `session_start` auto-prune: stale done (>7d) → moved to archive; fresh done (<7d) → stays in live; open/in_progress/parked untouched.
- Auto-prune never uses `--all` (fresh done <7d stays even if `--all` would move it).
- Auto-prune is a no-op when nothing is stale (live store unchanged, no prune notify payload).
- Idempotent: running twice (two session_starts) → second is a no-op.
- `cancelled` also auto-pruned when stale.
- Rich result: `PruneDetail.items` has id + status + title + ageDays.

### 10.2 Extend `test/todo-archive.test.mts`
- `pruneTodos({ detail: true })` returns `items` with `ageDays` computed from `closedAt`.
- `listDoneUnified`: live done + archived done merged, `cancelled` excluded, sorted newest-closed first, `location` tag correct, filters (text/project/since/before/limit/page) work.
- `listDoneUnified` empty when no done todos.

### 10.3 Extend `test/panel-data.test.mts`
- `todoDoneItem` (or `todoToItem` with location): label includes `[live N]` / `[archived <date>]`.

### 10.4 Extend `test/todo-store.test.mts` (if `list status:done` routing changes)
- `listTodos({ status: "done" })` still returns live done (back-compat) — the unification happens at the extension layer for the `todo list status:done` tool call, OR move unification into the store. **Decision:** keep `listTodos({status:"done"})` as live-only (back-compat); the unification lives in `listDoneUnified` (archive.ts), called by the extension for `todo list status:done`. So no `todo-store` change for routing — test that `listTodos({status:"done"})` is unchanged.

### 10.5 Manual-gate (no unit test)
- Extension `session_start` auto-prune + notify format.
- `/todo` panel Done tab (rendering, filter, action submenu, restore-from-archive).
- `/todo done` slash.
- `todo list status:done` unified output.

Verified by RECTOR in a real pi session before merge (same gate as v0.3.0).

## 11. Branch + ship

- Branch `feat/auto-prune-done-view` off `main`.
- Commits: `feat(auto-prune): ...`, `feat(prune): rich result ...`, `feat(done): unified listing ...`, `feat(panel): Done tab ...`, `test: ...`, `docs: ...` — one logical change per commit.
- PR to `main`, `--merge --delete-branch`. No GitLab mirror (getpipher).
- **QA gate:** RECTOR tests in a real pi session: stale done auto-prunes on start (fresh done stays); the notify shows the rich result; `/todo done` + the Done tab show unified done (live + archive, tagged); `todo restore <id>` undoes an auto-prune; injection unchanged (only active injected).
- Tag `v0.3.1` → CI auto-publish (npm) + auto-create GitHub Release (the v0.3.0-post workflow change).
- Post-ship: bump README/AGENTS test count + add the Done tab / auto-prune to the docs; mark this spec shipped.

## 12. Open question (resolve at implementation)

- **`pruneTodos` `detail` flag vs always-rich:** simplest is to make the rich `items` always returned (no flag) and have callers that only need `{moved, ids}` ignore `items`. Decide during implementation — leaning toward always-return for simplicity, since the cost is computing `ageDays` (trivial) per moved todo.

## 13. Out of scope (future)

- **`cancelled`-in-live panel visibility** — a pre-existing gap; could add a `Cancelled` filter or fold into the Archive tab's live portion in a future workstream.
- **`config.prune.autoOnSessionStart` toggle** — disable auto-prune (v0.4.x).
- **Auto-prune notify dedup** — if `/reload` fires multiple times in a session, the notify repeats; acceptable for v0.3.1 (it's a transient inform).
- **Workstream C (v0.4.0):** preventive caps-on-add (notes length cap + project registry) — still the next major milestone.