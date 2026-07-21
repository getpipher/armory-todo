# Workstream B — `title` + `notes` schema split (v0.3.0)

**Date:** 2026-07-21
**Status:** Design approved → pending implementation plan
**Branch:** `feat/title-notes-split` off `main`
**Predecessor:** v0.2.0 (Workstream A — lifecycle boxes + prune + health + TUI panel), PR #3, shipped 2026-07-21
**Supersedes (for this scope):** `2026-07-20-lifecycle-boxes-prune-design.md` §14 (which deferred this exact split to Workstream B)
**Target ship:** v0.3.0, auto-published via `release.yml` on `v0.3.0` tag

---

## 1. Problem

v0.2.0 shipped the lifecycle boxes (active / parked / archive) — that fixed the *count* of injected todos. It did not fix the *per-todo size*. The `Todo` schema has a single `text` field that is a junk-drawer: a todo's title AND its running log crammed into one string. The live ZeroClaw todo (`td-mrt3zp9fcnug3p`) is ~1.8KB and is injected verbatim into every fresh session's system prompt via `renderOpenBlock`. RECTOR flagged "why is there no title field?" during v0.2.0 QA; the v0.2.0 panel's ~80-char truncation is a band-aid treating the symptom.

This workstream is the real fix: **split `text` into `title` (short, injected) + `notes` (long, not injected).**

## 2. Goals

- A todo's **title** is a ≤120-char one-line summary — the only thing injected into the system prompt and shown in compact lists.
- A todo's **notes** is an arbitrary-length editable body — the running detail, progress log, pointers. Never auto-injected.
- The model can **read notes on demand** via a new `get` action (so `list` can become compact without losing retrievability).
- Backwards-compatible with v0.2.0 stores: v2→v3 migration runs on load, curated for the 2 known todos + a deterministic fallback for any others.
- No re-bloat: a hard cap on `title` at the write boundary prevents the junk-drawer pattern from re-forming inside `title`.

## 3. Non-goals (deferred)

- **Append-only `log` array** (timestamped entries). Considered (option B/C in brainstorm) and rejected as YAGNI — the bloat fix only needs a title/body split, not structured history. Clean v0.4.0 addition on top of `notes` if it earns its place.
- **Notes caps-on-add + project registry** — Workstream C (issue #1's hard-block half). `notes` is uncapped in B; health reports notes-bytes as a diagnostic only.
- **In-panel multi-line notes editing** — blocked by the v0.2.0 constraint that `ctx.ui.editor()` from inside `ctx.ui.custom()` causes a nested-UI bug (`/todo` won't reopen). Tracked as a known deferred issue; `notes` is model-managed via the `todo` tool until a safe pattern exists.

## 4. Decisions log (from brainstorm Q&A)

| # | Question | Decision |
|---|---|---|
| Q1 | Shape of the notes side | **A** — `notes` single editable string. No append-only log. |
| Q2 | Migration of existing `text`-only todos | Hand-curated for the 2 known ids; first-line fallback for any others. No heuristic sentence-split. |
| Q3 | Panel handling of notes | **C** — detail view shows title+notes read-only; inline Edit edits title only; notes via `todo` tool; limitation tracked as known deferred issue. |
| Q4 | `add`/`update` tool surface | **A** — clean break. `add` requires `title` (+optional `notes`); `text` param removed. `update` gains `title`+`notes`, drops `text`. `list.text` searches title+notes. |
| Q5 | Reading notes | **A** — new `get` action returns one todo's full record. `list` shows title + `•` indicator when notes non-empty. |
| Q6 | Title cap | **A** — hard reject >120 chars at `add`/`update`. `notes` uncapped in B. |

## 5. Schema (`src/todo-store.ts`)

### 5.1 `Todo` interface

```ts
export interface Todo {
  id: string;
  title: string;       // NEW — ≤120 chars, non-empty, trimmed
  notes: string;       // NEW — any length, may be ""
  project: string;
  tags: string[];
  priority: Priority;
  status: Status;
  source: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  // `text` REMOVED
}
```

### 5.2 `Store`

```ts
export interface Store {
  version: 3;          // was 2
  updatedAt: string;
  todos: Todo[];
}
```

`emptyStore()` returns `version: 3`.

### 5.3 Inputs

```ts
export interface AddInput {
  title: string;       // required (was: text)
  notes?: string;      // optional, default ""
  project?: string;
  tags?: string[];
  priority?: Priority;
  source?: string;
  // `text` REMOVED
}

export interface UpdateInput {
  title?: string;      // non-empty + ≤120 if present
  notes?: string;      // "" clears
  project?: string;
  tags?: string[];
  priority?: Priority;
  status?: Status;
  // `text` REMOVED
}
```

`ListFilter.text` stays — its semantic is "search query", not "the text field" (see §7.3).

### 5.4 Title cap constant

```ts
const TITLE_MAX = 120;
```

Enforced in `addTodo` and `updateTodo`:

```ts
function normalizeTitle(raw: string): string {
  const t = raw.trim();
  if (!t) throw new TodoError("title is required");
  if (t.length > TITLE_MAX) {
    throw new TodoError(`title must be ≤${TITLE_MAX} chars (got ${t.length}); move detail into notes`);
  }
  return t;
}
```

`notes` is trimmed but **not** length-checked. `addTodo` with no `notes` → `notes: ""`. `updateTodo` with `notes: ""` → clears.

## 6. Migration v2→v3 (`src/migrate.ts`)

### 6.1 When it runs

In `loadStore`, after the existing v1→v2 file-move migration (which is guarded to default `TODO_DIR`), if `parsed.version === 2`:

```ts
if (parsed.version === 2) {
  parsed = migrateV2ToV3(parsed);   // in-memory transform
  saveStore(parsed);                // persist once → v3 on disk
}
```

Subsequent loads see `version: 3` and skip migration.

### 6.2 No env guard (unlike v1→v2)

The v1→v2 migration moves the *real* legacy file (`~/.pi/agent/todo.json`) — that's why it's guarded to default `TODO_DIR` (the v0.2.0 incident lesson). The v2→v3 migration only touches the *live* path (`<TODO_DIR>/todo.json`) — which in tests is a temp dir. It never reaches the real legacy file, so it does **not** need the env guard. The v1→v2 guard stays as-is.

### 6.3 Curated map (the 2 known todos)

Hardcoded by id. The titles + notes were hand-curated during the 2026-07-21 brainstorm session (reformatted for clarity, not a mechanical split):

```ts
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
```

### 6.4 Fallback (any other v2 todo)

For a v2 todo whose `id` is not in `CURATED_V2_TO_V3`:

1. Split `text` on the first `\n` → `firstLine`, `rest`.
2. If `firstLine.length ≤ TITLE_MAX`: `title = firstLine.trim()`, `notes = rest.trim()`.
3. If `firstLine.length > TITLE_MAX`: truncate at the last word boundary ≤ `TITLE_MAX` (fall back to hard cut at `TITLE_MAX` if no boundary). `title` = the truncated form (no `…` suffix — the cap is a hard rule, not a display truncation). `notes` = the **full original `firstLine`** + `\n` + `rest` (nothing lost).
4. If `text` is a single line (no `\n`): `title = text.trim()` (capped as in step 2/3), `notes = ""` — unless step 3 truncation applied, in which case `notes` = the full original `text`.
5. If `text` is empty/whitespace (shouldn't happen — v2 `addTodo` rejected empty text, but defensively): `title = "(untitled)"`, `notes = ""`.

The fallback is deterministic and idempotent — running it twice on the same v2 todo yields the same v3 todo.

### 6.5 `migrateV2ToV3` signature

```ts
export function migrateV2ToV3(store: { version: 2; updatedAt: string; todos: V2Todo[] }): Store {
  const todos = store.todos.map((t) => {
    const curated = CURATED_V2_TO_V3[t.id];
    if (curated) return { ...t, title: curated.title, notes: curated.notes, text: undefined };
    const { title, notes } = splitTextFallback(t.text);
    return { ...t, title, notes, text: undefined };
  });
  return { version: 3, updatedAt: store.updatedAt, todos } as Store;
}
```

`V2Todo` is the v2 shape (with `text`, without `title`/`notes`). The `text: undefined` is stripped by JSON.stringify on save (so v3 files on disk have no `text` key).

## 7. Tool surface (`extensions/todo.ts`)

### 7.1 `ACTIONS`

```ts
const ACTIONS = ["list", "add", "update", "get", "complete", "delete", "clear", "park", "prune", "restore", "health"] as const;
```

`get` added.

### 7.2 Input schema (typebox)

- `title: Type.Optional(Type.String({ description: "Todo title (add required; update optional). ≤120 chars." }))`
- `notes: Type.Optional(Type.String({ description: "Todo notes/body (add/update optional; long-form, not injected). Pass \"\" on update to clear." }))`
- `text`: kept, but description rewritten to `Type.Optional(Type.String({ description: "Search query (list only) — substring match on title OR notes. Not used by add/update." }))`
- `id`, `project`, `tags`, `priority`, `status`, `archived`, `since`, `before`, `limit`, `page`, `ageDays`, `all`, `hard`, `confirm`, `box`, `olderThan` — unchanged.

### 7.3 Action behaviors

**`add`**: require `title` (error if missing/empty). `notes` optional. Calls `addTodo({ title, notes, project, tags, priority, source })`. Output: `Added ${id}: ${title}`.

**`update`**: require `id`. Patch `{ title, notes, project, tags, priority, status }` (only fields present). `title`/`notes` flow through `updateTodo`. Output: `Updated ${id}: ${title} [${status}]`.

**`get`** (NEW): require `id`. Calls a new exported `getTodo(id)` store function (added to `src/todo-store.ts` — loads the store, finds by id, throws `TodoError` if missing, returns the `Todo`). The extension formats it as a full record:
```
${id} [${priority}/${status}] ${title}
project: ${project || "(none)"}
tags: ${tags.join(", ") || "(none)"}
created: ${createdAt}
updated: ${updatedAt}
closed: ${closedAt || "(open)"}
source: ${source || "(none)"}

notes:
${notes || "(empty)"}
```
`TodoError` if id not found → extension returns the error message (existing catch).

**`list`**: `text` filter now matches `title` OR `notes` (case-insensitive substring). Output fmt:
```
- [${id}] (${priority}/${status})${notesDot} ${title}${tag}${pins}
```
where `notesDot = notes.trim() ? " •" : ""`, placed immediately after the priority/status parenthetical so the title stays clean and the indicator is discoverable. `tag = project ? " (${project})" : ""`, `pins` unchanged (⏵ for in_progress, etc.).

**`complete`/`delete`/`park`/`clear`/`prune`/`restore`**: output lines show `title` instead of `text`. e.g. `Completed ${id}: ${title}`, `Parked ${id}: ${title}`, `Restored ${id}: ${title} [open]`.

### 7.4 Prompt guidelines (rewritten)

```
Use todo (action:'add', title, notes?, project?, tags?, priority?, source?) when the user says 'put this in our TODO'. title is ≤120 chars (one-line summary); put long detail in notes.
Use todo (action:'get', id) to read a todo's full notes before acting on it (the • marker in lists means notes exist).
Use todo (action:'update', id, title?, notes?, …) to edit; notes="" clears.
Use todo (action:'list', text?) to scan titles (text searches title+notes); add archived:true to query the archive.
Use todo (action:'park', id) to defer (not injected); (action:'update', id, status:'open') to un-park.
Use todo (action:'prune') to move done/cancelled to archive (reversible via restore); prune --hard (confirm:true) is the only irreversible action.
Never put secrets in a TODO — the text reaches the model provider.
```

### 7.5 Slash command (`/todo`)

`/todo add <title>` — was `/todo add <text>`. The slash parser passes the remainder as `title`. `/todo add <title> | <notes>`? **No** — keep slash add simple (title only); notes added via the tool or panel. (The slash command is for quick human adds; notes are model-managed.) Document this.

Other slash subcommands unchanged (just show `title` in output).

## 8. Auto-injection (`renderOpenBlock`)

```ts
const lines = shown.map((t) => {
  const tag = t.project ? ` (${t.project})` : "";
  const pin = t.status === "in_progress" ? " ⏵" : "";
  const dot = t.notes.trim() ? " •" : "";
  return `- [${t.id}] (${t.priority})${pin}${dot} ${t.title}${tag}`;
});
```

**`title` only — never `notes`.** The `•` marker tells the model "this todo has notes; `get` it before acting." The 1.8KB ZeroClaw blob → one line. This is the bloat fix.

## 9. Panel (`src/panel.ts` + `src/panel-data.ts`)

### 9.1 List rows

`todoToItem` returns a `SelectListItem` whose `label` is `title` + `•` (when notes non-empty) + project tag + status pin. The v0.2.0 ~80-char truncation hack (`truncateForList`) is **deleted** — `title` is already ≤120 chars by the cap.

### 9.2 Detail view

Selecting a todo (Enter on a list row) opens a detail view inside the panel:
- Bordered, scrollable region rendering:
  ```
  ${title}
  (${priority}/${status}) · ${project || "no project"} · ${tags.join(" ")}

  notes:
  ${notes}
  ```
- Footer hint: `notes: read-only · todo update <id> notes=… to edit`
- Back action returns to the list.

### 9.3 Inline Edit

The Edit action (from the action submenu or a detail-view key) edits **`title` only** via a single-line `Input` (same constraint as v0.2.0 — `ctx.ui.editor()` from inside `ctx.ui.custom()` is the known nested-UI bug). Saving writes via `updateTodo(id, { title })`.

### 9.4 Known deferred issue (carried from v0.2.0)

> No in-panel multi-line `notes` editing. `notes` is model-managed via the `todo` tool (`action:'update', id, notes`). When a safe `ctx.ui.editor()`-from-`custom()` pattern lands in pi-tui, notes panel-editing is a clean follow-up.

Tracked in README "Known issues" + AGENTS.md.

## 10. Health (`src/health.ts`)

The bloat report gains a **notes-bytes diagnostic** (read-only — no caps enforced in B):

```
notes bytes: total=N max=M avg=A  (active+parked)
```

Computed across active + parked todos. Lets you see notes bloat growing (the latent bloat that *isn't* injected). Existing count-based heuristics unchanged. Workstream C will add caps-on-add.

## 11. Archive (`src/archive.ts`)

Archived todos carry `title` + `notes` (same `Todo` shape). `archiveSummary` (counts by project/month) is unaffected. `listArchived` fmt shows `title` + `•` (same as `list`). `restoreTodo` returns the todo — output shows `title`. No archive-specific migration: the v2→v3 migration in §6 runs on the *live* store on load; the archive file is v3-only going forward. **Edge case:** if a v2 `todo-archive.json` exists (it doesn't today — the incident wiped the store and only 2 todos were recovered, none archived), `loadArchive` must also migrate v2→v3 on first load using the same `migrateV2ToV3` (curated map + fallback). Add this guard symmetrically.

## 12. Tests

Baseline: 151 across 7 suites. Target: ~175+.

### 12.1 New suite `test/todo-title-notes.test.mts`

- `addTodo` with `title` only (notes defaults to `""`)
- `addTodo` with `title` + `notes`
- `addTodo` rejects empty `title`
- `addTodo` rejects `title` >120 chars (exact boundary: 120 ok, 121 reject)
- `addTodo` trims `title` before length check (trailing whitespace doesn't count)
- `updateTodo` with `title` (non-empty, ≤120)
- `updateTodo` with `notes` (set, clear with `""`)
- `updateTodo` rejects `title` >120
- `getTodo` returns full record (found)
- `getTodo` missing id → `TodoError`
- `listTodos` `text` filter matches `title` OR `notes`
- `listTodos` output includes `•` when notes non-empty, omits when empty
- `renderOpenBlock` renders `title` only (never `notes`), includes `•`

### 12.2 Extend `test/todo-migrate.test.mts`

- v2→v3 curated: the 2 known ids get the hand-written title+notes (exact match)
- v2→v3 fallback: single-line text → title=whole, notes=""
- v2→v3 fallback: multi-line text → title=first line, notes=rest
- v2→v3 fallback: first line >120 → title=truncated at word boundary ≤120, notes=full original first line + rest
- v2→v3 fallback: first line >120 with no word boundary → title=hard cut at 120, notes=full original
- v2→v3 idempotent (running on a v3 store is a no-op / `loadStore` skips)
- v2→v3 persists to disk on first load (second load sees version 3)
- v2→v3 does **not** require the default-`TODO_DIR` guard (runs in temp-dir test fixtures) — explicit test that it works with `TODO_DIR` set

### 12.3 Extend `test/todo-store.test.mts`

- Update existing add/update/list tests that referenced `text` → use `title`/`notes`
- Add title-cap error cases (mirror 12.1 where they overlap — keep the boundary tests in the dedicated suite, reference cases in store tests)

### 12.4 Extend `test/panel-data.test.mts`

- `todoToItem` label uses `title` (no truncation)
- `todoToItem` label includes `•` when notes non-empty
- `todoToItem` label omits `•` when notes empty

### 12.5 Extend `test/todo-archive.test.mts`

- `listArchived` fmt shows `title` + `•`
- v2 archive file → v3 migration on load (curated + fallback) — symmetric with live store
- `restoreTodo` output shows `title`

### 12.6 Extend `test/todo-health.test.mts`

- Report includes `notes bytes: total/max/avg` line
- Values computed across active+parked only (archived excluded)

### 12.7 Existing suites

`todo-config.test.mts`, `todo-hard-prune.test.mts` — no title/notes-specific changes, but any test fixtures using v2 `text`-only todos must be updated to v3 shape (`title`+`notes`). Audit + fix.

## 13. Branch + ship

- Branch `feat/title-notes-split` off `main`.
- Commits: `feat(store): ...`, `feat(migrate): ...`, `feat(ext): ...`, `feat(panel): ...`, `feat(health): ...`, `test: ...`, `docs: ...` — one logical change per commit.
- PR to `main`, `--merge --delete-branch`. No GitLab mirror (getpipher).
- **QA gate:** RECTOR tests in a real pi session before merge — local install (`pi install npm:@getpipher/armory-todo` or local path) → restart pi → verify:
  1. v2→v3 migration runs on first load (the 2 known todos get curated titles/notes).
  2. `## Open TODOs` injection shows title only (+ `•`), not the 1.8KB blob.
  3. `/todo` panel list shows titles + `•`; detail view shows notes; Edit edits title.
  4. `todo add` with `title`+`notes` works; `todo get <id>` returns notes; `todo update <id> notes=…` edits notes.
  5. Title >120 rejects with actionable error.
- Tag `v0.3.0` → CI auto-publish (`release.yml`, org `NPM_TOKEN`, no OTP).
- Post-ship: update README (test count, schema section, known issues), AGENTS.md (modules list + known deferred issues), this spec → status "shipped".

## 14. Incident lesson (carried forward from v0.2.0)

The v0.2.0 SPEC-1 Task 9 incident: `migrateIfNeeded` ran in test mode (`TODO_DIR` = temp dir), moved the real `~/.pi/agent/todo.json` (52KB, 47 todos) into the temp dir, test cleanup deleted it. Fix: v1→v2 file-move migration is guarded to only run when `TODO_DIR` is the default.

**For Workstream B:** the v2→v3 schema migration (§6) does **not** need this guard — it only touches the live path (`<TODO_DIR>/todo.json`), never the real legacy file. But the lesson stands: any future migration that *moves real user data between paths* must be guarded by environment, not test conventions. The v2→v3 transform is in-memory + persist-to-same-path — safe under `TODO_DIR` override.

## 15. Out of scope (future workstreams)

- **Workstream C (v0.4.0):** preventive caps-on-add (`notes` length cap, project registry, self-awareness caps) — issue #1's hard-block half.
- **Append-only `log` (v0.4.0+):** structured timestamped entries on top of `notes`, if it earns its place.
- **In-panel multi-line notes editor:** blocked on a safe `ctx.ui.editor()`-from-`custom()` pattern in pi-tui.