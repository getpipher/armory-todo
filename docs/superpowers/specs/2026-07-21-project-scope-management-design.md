# Project-Scope Management — Design (v0.4.0, Workstream C / Feature A)

**Date:** 2026-07-21
**Workstream:** C → Feature A (issue #1's project-scope half)
**Release:** v0.4.0
**Predecessors:** v0.3.1 (auto-prune + unified Done view) — 255/255 tests, 9 suites
**Successor:** v0.5.0 — Feature B (caps enforcement: count cap + notes cap + over-cap injection summary). This spec is **advisory-only**; no enforcement ships here.

**Branch:** `feat/project-scope-management` off `main`
**Commits:** `feat(scope): ...` per task. PR → `--merge --delete-branch`. RECTOR QA gate → tag `v0.4.0` → CI auto-publishes npm + GitHub Release (now automatic).

---

## 1. Problem (the real one, restated)

The injected `## Open TODOs (N)` block is already bounded (v0.3.0 title-only injection + `renderOpenBlock(max=15)` + v0.3.1 auto-prune). What's **still unsolved**:

1. **No forcing function on the *count*.** Open can grow to 30/50/100 with no pushback; the injection *hides* the rot behind `+N more`. A cap is a triage signal, not a bytes fix.
2. **No scope overview.** `project` is free-text, un-aggregated. Working across ZeroClaw, getpipher, vision, etc., you can't see "this project owns 18 of my 22 open" — can't triage *where* to cut. The bigger daily pain than the cap.
3. **No per-project bloat signal in `health`.** `ACTIVE_LARGE` fires globally at >15; can't say *which* project is over budget.
4. **No curation surface.** A typo'd project string (`foo-bat` vs `foo-bar`) silently becomes its own "project" with no way to merge.

v0.4.0 is the **triage visibility** release: see the backlog by project + know when one's over budget + fix typos. **No enforcement** — that's v0.5.0's "caps release" (count + notes + injection, all block-on-add).

---

## 2. Scope (locked decisions)

| Decision | Choice | Rationale |
|---|---|---|
| **Release slice** (Q1) | B — v0.4.0 = Feature A only; v0.5.0 = Feature B (caps) | Lands triage visibility (the daily pain) before the cap that needs it. v0.4.0 is zero-enforcement-risk. |
| **Registry vs dynamic** (Q2) | C — full registry with per-project config slots | Forward-looking for armory-todo; canonical name list + rename/merge (the point of a registry over dynamic derivation). |
| **`maxOpen` slot behavior in v0.4.0** (Q3) | A — advisory `health` flag now; enforcement (block-on-add) in v0.5.0 | Slot is never inert: graduates advisory → hard block. No lying UI. |
| **Notes cap in v0.4.0?** (Q4) | A — defer to v0.5.0 | v0.4.0 is purely the project-scope axis; v0.5.0 is "the caps release" (count + notes + injection). |
| **Registry storage** (Q5) | B — sibling `~/.pi/agent/todo/projects.json` | Registry is *state* (grows, auto-seeds); config is *settings*. Separation avoids a config schema bump + the risky live-store migration. |
| **Registry entry shape** (Q6) | A — minimal `{ name, maxOpen, createdAt, updatedAt }` | Every field earns its weight; `lastSeenAt`/reserved slots re-introduce the inert-field hazard. |
| **Registry sync** (Q7) | A — lazy sync-on-read | No writes on `add`/`update`; `projects`/`health` reconcile first. First read seeds; later reads self-heal. No cross-path risk (file lives under `TODO_DIR`). |
| **Rename/merge** (Q8) | B — included, full consistency (live + archive + registry) | Rename is the point of a registry; half-way (archive sealed) re-splits the project in the view. |
| **`projects` output** (Q9) | B — counts + cap signal + typo marker | One-stop triage; staleness/notesBytes stay in `health` (whole-store concerns). |
| **`health` per-project flags** (Q10) | C — `PROJECT_OVER` + `PROJECT_TYPO` + `PROJECT_LARGE` + `PROJECT_STALE` | `PROJECT_LARGE` (global default threshold) makes the per-project signal useful on day 1, not gated behind per-project config. All advisory. |
| **Action API + slash naming** (Q11) | A — tool `action:'projects'` + `action:'project_rename'`; slash `/todo projects` (thin mirror) | Plural=list, singular=action namespace. No `/todo project rename` slash — rename is panel-only (Q12). |
| **Panel surface** (Q12) | A — 6th tab `projects` + per-project action submenu | Panel is the primary human surface (getpipher UX mental model: interactive first, CLI-style for the agent). |
| **UX mental model** | Documented in `~/local-dev/getpipher/AGENTS.md` (cross-cutting, all getpipher extensions) | Panel-first design order; tool action + slash are secondary/derived. |

**Defaults (Q13):** `health.perProjectDefaultMax = 8`; `maxOpen` per-project default `null`; `PROJECT_STALE` reuses `activeStaleDays` (30d); `PROJECT_TYPO` = exactly 1 todo in project (live + archived done); seed scope = live + archive; empty-project group = `(no project)` (excluded from typo detection, no `maxOpen`); rename is best-effort multi-file (live → archive → registry, backup-on-corrupt per file, no cross-file WAL).

---

## 3. Architecture

### 3.1 New file: `projects.json` (registry state)

`~/.pi/agent/todo/projects.json` — the project registry. Auto-seeded on first read, lazy-synced on every registry touch.

```json
{
  "version": 1,
  "updatedAt": "2026-07-21T12:00:00.000Z",
  "projects": [
    {
      "name": "foo-bar",
      "maxOpen": 5,
      "createdAt": "2026-07-21T12:00:00.000Z",
      "updatedAt": "2026-07-21T12:00:00.000Z"
    }
  ]
}
```

- **`version: 1`** — bump on future schema changes (e.g. v0.5.0 may add per-project `maxNotesBytes`).
- **`maxOpen: number | null`** — advisory cap slot. `null` (default) → no `PROJECT_OVER` flag for this project. v0.4.0: drives `health` flag only. v0.5.0: enforcement (block-on-add).
- **`name`** — canonical project string. Unique within `projects[]`. Empty string `""` is NOT a registry entry (the `(no project)` group is implicit, never registered).
- Atomic 0600 write (tmp + rename), same pattern as `saveStore`/`saveConfig`.

### 3.2 New module: `src/registry.ts`

Pure, pi-independent (like the other `src/` modules). No new runtime deps.

```ts
export interface ProjectEntry { name: string; maxOpen: number | null; createdAt: string; updatedAt: string; }
export interface ProjectRegistry { version: 1; updatedAt: string; projects: ProjectEntry[]; }

export function getRegistryPath(): string;           // <TODO_DIR>/projects.json
export function loadRegistry(): ProjectRegistry;     // corrupt → backup .bad-<ts>, fresh
export function saveRegistry(reg: ProjectRegistry): void;  // atomic 0600
export function reconcileRegistry(reg, liveTodos, archivedTodos): { reg, changed };  // lazy sync: append unknown project strings with maxOpen:null
export function getProjectEntry(reg, name): ProjectEntry | undefined;
export function setProjectMaxOpen(reg: ProjectRegistry, name: string, max: number | null): ProjectEntry;  // max=null clears; creates entry if unknown; throws if name === "" (no-project group can't be capped)
export function renameProject(reg, oldName, newName): { reg, liveTodos, archivedTodos, liveChanged, archivedChanged };  // rewrites registry + both stores in place
```

**Lazy sync (`reconcileRegistry`):** collect distinct non-empty `project` strings across `liveTodos` + `archivedTodos`; for any not in `reg.projects`, append `{ name, maxOpen: null, createdAt: now, updatedAt: now }`. Bump `reg.updatedAt` iff changed. Caller persists iff `changed`.

**Seed:** `loadRegistry()` on a missing file returns an empty registry (`{ version: 1, updatedAt: now, projects: [] }`) and does NOT seed. Seeding happens on the first `reconcileRegistry` call (inside `projectsOverview`/`healthReport`), which persists. This keeps `loadRegistry` side-effect-free (matches `loadConfig`'s "missing → write defaults" pattern is NOT used here — we seed lazily to keep load pure + avoid a write on a bare load).

**No env guard:** `projects.json` always lives under `TODO_DIR` (temp dir in tests), so no cross-path migration risk (unlike v1→v2 file-move). Tests get isolated registries for free.

### 3.3 New module: `src/projects.ts` (overview)

Pure read + reconcile. The `projects` action's brain.

```ts
export interface ProjectOverviewRow {
  name: string;
  open: number;
  in_progress: number;
  parked: number;
  done: number;          // live done + archived done
  total: number;         // open + in_progress + parked + done
  maxOpen: number | null;
  over: boolean;         // open > maxOpen (only when maxOpen !== null)
  typo: boolean;          // exactly 1 todo (live + archived done) in the project
  lastUpdated: string;   // max updatedAt across the project's live todos (ISO), or "" if none live
}

export interface ProjectsOverview {
  rows: ProjectOverviewRow[];      // sorted: open desc → total desc → name asc
  totalTodos: number;              // sum of all rows' total
  noProject: { count: number; open: number };  // the (no project) bucket — not a row
}

export function projectsOverview(): ProjectsOverview;
```

**Typo nearest-sibling:** `typo: true` rows are reported in `health` suggestions with a nearest-sibling guess (Levenshtein ≤ 2 among other registry names). The `projects` row carries `typo: true`; the suggestion text carries the guess. (Edit-distance helper lives in `projects.ts` or a tiny `src/levenshtein.ts` — small enough to inline.)

**`(no project)` bucket:** todos with `project === ""` are aggregated into `noProject`, NOT a row (no `maxOpen`, no typo, no rename target). Surfaced in the overview summary + `health`.

### 3.4 `src/health.ts` — extend with per-project flags

New flags + a new config field (forward-compatible merge, no schema bump):

```ts
export type HealthFlag =
  | "ACTIVE_LARGE" | "ACTIVE_STALE"
  | "PARKED_LARGE" | "PARKED_STALE"
  | "ARCHIVE_LARGE" | "ARCHIVE_OLD"
  | "PROJECT_OVER" | "PROJECT_TYPO" | "PROJECT_LARGE" | "PROJECT_STALE";  // new
```

`HealthConfig` gains `perProjectDefaultMax: number` (default 8). `loadConfig`'s existing merge (`{ ...DEFAULT_CONFIG.health, ...parsed.health }`) fills it for old configs — no migration.

`HealthReport` gains:

```ts
export interface ProjectHealth { name: string; open: number; maxOpen: number | null; over: boolean; typo: boolean; large: boolean; stale: boolean; lastUpdated: string; }
export interface HealthReport {
  // ...existing fields...
  projects: ProjectHealth[];   // only projects with ≥1 flag, sorted open desc
  noProject: { open: number };  // (no project) open count, for context
}
```

Flag logic per project (live open count is the `open` figure):
- `PROJECT_OVER` — `maxOpen !== null && open > maxOpen`
- `PROJECT_LARGE` — `open > config.health.perProjectDefaultMax` (default 8; fires even when `maxOpen` is null — the day-1 signal)
- `PROJECT_STALE` — `lastUpdated !== "" && daysAgo(lastUpdated) > config.health.activeStaleDays` (30d)
- `PROJECT_TYPO` — total todos (live + archived done) in the project === 1 AND a near-named sibling (Levenshtein ≤ 2) exists in the registry

`healthReport()` calls `reconcileRegistry` first (so the registry is current), persists iff changed, then computes. Suggestions gain per-project actionable lines, e.g.:
- `project 'foo-bat' has 1 todo — possible typo of 'foo-bar'? → todo project rename foo-bat foo-bar`
- `project 'getpipher' 12 open (maxOpen 5) → close/park some, or raise maxOpen`
- `project 'bug-bounty' 9 open (per-project default max 8) → over budget`
- `project 'vision' untouched 45d → stale, park or close`

### 3.5 `src/todo-store.ts` — no schema change, no new writes

`addTodo`/`updateTodo` are **unchanged** (no registry write — lazy sync, Q7=A). The live store stays `Store.version: 3`. `Todo.project` stays free-text. No migration.

### 3.6 `extensions/todo.ts` — new tool actions + panel tab + thin slash

#### Tool actions (agent surface)
- `action: 'projects'` → returns `ProjectsOverview` (structured). No params.
- `action: 'project_rename'` → params `oldName: string`, `newName: string`. Returns `{ liveRenamed: number, archivedRenamed: number, merged: boolean, newName: string }`. Throws `TodoError` if `oldName` not in registry. `newName` may equal an existing different project — rename-onto-existing is a **merge** (consolidates `oldName` todos into `newName`, removes the `oldName` registry entry, keeps `newName`'s entry; `merged: true`). This is the typo-cleanup path (`foo-bat` → `foo-bar` where `getpipher` already exists). Self-rename (`newName === oldName`) is a no-op success (`{ liveRenamed: 0, archivedRenamed: 0, merged: false, newName }`).

#### Panel (human surface — primary)
New 6th tab `projects` in the `/todo` panel (existing 5: active/parked/done/archive/config → now 6). Tab label `Projects`.

- **Rows:** `ProjectOverviewRow` rendered as: `name  open/in_progress/parked/done (total)  [max:N or —]  OVER?  ?typo  · lastUpdated`. Box-draw to match existing tab style.
- **Sort:** open desc → total desc → name asc (Q9).
- **Action submenu** (per project, via `openActionSubmenu`): `Rename` / `Set maxOpen` / `Filter active to project`.
  - **Rename** — inline `Input` (single-line; pi-tui can't nest `ctx.ui.editor()` inside `ctx.ui.custom()`). Validates `newName` non-empty + not equal to current. Calls `renameProject`. Confirms merge if target exists. Notify on success (`Renamed foo-bat → foo-bar (3 live + 1 archived)`).
  - **Set maxOpen** — inline `Input`, accepts a positive integer or `clear` (→ `null`). Calls `setProjectMaxOpen`. Notify (`getpipher maxOpen = 5` or `getpipher maxOpen cleared`).
  - **Filter active to project** — jumps to the `active` tab with a `project` filter applied (existing list filter already supports `project`).
- **`(no project)` bucket** — shown as a non-selectable summary row at the top or footer (`(no project): N open`), no submenu.

#### Slash (thin mirror only)
- `/todo projects` — prints the `ProjectsOverview` as text (mirrors `/todo health`'s text-report style). One new sub. **No** `/todo project rename` slash — rename is panel-only (Q12=A + getpipher UX mental model).

### 3.7 `src/config.ts` — one new field, no schema bump

`HealthConfig` gains `perProjectDefaultMax: number` (default 8). `DEFAULT_CONFIG.health.perProjectDefaultMax = 8`. `loadConfig`'s merge fills it for old configs. `TodoConfig.version` stays `1`.

### 3.8 No injection change

`renderOpenBlock` is **unchanged** in v0.4.0 (no caps, no over-cap summary — that's v0.5.0). The `## Open TODOs (N)` block keeps its current shape (≤15 title-only rows + `+N more`).

---

## 4. Data flow

### 4.1 `todo projects` (tool) / `/todo projects` (slash) / Projects tab (panel)
1. `loadStore()` (live) + `loadArchive()` (archived done).
2. `loadRegistry()` → `reconcileRegistry(reg, live, archive)` → persist iff changed.
3. `projectsOverview()` computes rows from live + archive + registry.
4. Return (tool) / render (panel) / print (slash).

### 4.2 `todo health`
1. Same load + reconcile as 4.1.
2. `healthReport()` extends: existing box diagnostics + new `projects[]` (per-project flags) + `noProject`.
3. Render (existing text format + new `projects:` section).

### 4.3 `todo project_rename` (tool) / panel Rename
1. `loadRegistry()`, find `oldName` entry (throw if missing).
2. `loadStore()` + `loadArchive()`.
3. Validate `newName` (non-empty, trimmed; if equal to `oldName` → no-op success).
4. Rewrite live todos (`project === oldName` → `newName`, bump `updatedAt`), save store iff changed.
5. Rewrite archived todos (`project === oldName` → `newName`, bump archive `updatedAt`), save archive iff changed.
6. Registry: remove `oldName` entry, ensure `newName` entry exists (create if merge target was absent, keep if merge), bump `updatedAt`. Save registry.
7. Return `{ liveRenamed, archivedRenamed, merged, newName }`.
8. **Failure semantics:** best-effort, not cross-file transactional (no WAL). Each file write uses the existing backup-on-corrupt pattern. If step N fails, prior writes stand; the result reports what happened. A later `reconcileRegistry` self-heals any drift.

### 4.4 `todo update` / `todo add` with a project
- **Unchanged.** No registry write. The new project string is picked up on the next `projects`/`health` read (lazy sync).

---

## 5. Edge cases

- **Empty store** — `projectsOverview` returns `{ rows: [], totalTodos: 0, noProject: { count: 0, open: 0 } }`. `healthReport().projects = []`. Panel shows `(no projects)`.
- **All-done project** — seeded from archive (live has 0 todos for it). Row: `name  0/0/0/N (N)  [max:null]  · lastUpdated:""`. Not typo (total ≥ 1 but if total === 1 and it's archived done, still typo-eligible — a single archived todo under a near-typo'd name is still a typo). Typo counts live + archived done.
- **Rename onto self** — no-op success (`{ liveRenamed: 0, archivedRenamed: 0, merged: false, newName }`).
- **Rename onto existing (merge)** — allowed; `merged: true`; `oldName` entry removed, `newName` entry kept.
- **Rename to a name that only differs by case** (`getpipher` → `Getpipher`) — allowed (case-sensitive `project` is the existing contract); flags nothing special.
- **`(no project)` rename** — not a rename target (no registry entry for `""`). `setProjectMaxOpen("")` → throws `TodoError` (no project group can't have a cap).
- **Corrupt `projects.json`** — `loadRegistry` backs up to `projects.json.bad-<ts>` and returns a fresh empty registry; next reconcile re-seeds. No data loss (todos are the source of truth; the registry is derived + the maxOpen slots — which are the only non-derived data — are lost on corrupt, acceptable, same tradeoff as `todo.config.json`).
- **`maxOpen = 0`** — semantically "no open todos allowed for this project." v0.4.0: `PROJECT_OVER` fires if open > 0. v0.5.0: blocks any add. Valid (edge but meaningful — "this project is closed").
- **Two projects with the same name after a case-only rename** — can't happen (rename rewrites all todos to one casing; the registry has one entry per unique name).

---

## 6. Testing

New suite `test/registry.test.mts` + `test/projects.test.mts`; extend `test/todo-health.test.mts` + `test/panel-data.test.mts`. Baseline 255/255 → target ~300+.

### `test/registry.test.mts` (new, ~20)
- `loadRegistry` missing → empty registry, no file write (lazy seed).
- `loadRegistry` corrupt → backup `.bad-<ts>`, fresh empty.
- `saveRegistry` atomic + 0600.
- `reconcileRegistry` appends unknown (live + archive), bumps `updatedAt` iff changed, idempotent (no change on second call).
- `reconcileRegistry` ignores empty-string project (not registered).
- `getProjectEntry` hit/miss.
- `setProjectMaxOpen` create-if-unknown, set number, `null` clears.
- `renameProject` rewrites live + archive + registry, removes old, keeps/creates new, `merged` flag, no-op self-rename, throws on unknown old.

### `test/projects.test.mts` (new, ~15)
- `projectsOverview` row counts (open/in_progress/parked/done/total) from live + archive.
- `maxOpen` carried from registry; `over` only when `maxOpen !== null && open > maxOpen`.
- `typo` true iff total (live + archived done) === 1 AND near-sibling Levenshtein ≤ 2 exists.
- `(no project)` bucket aggregated, not a row.
- Sort: open desc → total desc → name asc.
- `lastUpdated` = max live `updatedAt`, `""` when no live todos.
- Empty store → empty overview.

### `test/todo-health.test.mts` (extend, +~15)
- `perProjectDefaultMax` default 8 + override via config.
- `PROJECT_OVER` (maxOpen set + exceeded), `PROJECT_LARGE` (default threshold, maxOpen null), `PROJECT_STALE` (lastUpdated > activeStaleDays), `PROJECT_TYPO` (1 todo + near-sibling).
- `healthReport().projects` only includes projects with ≥1 flag, sorted open desc.
- `noProject` reported.
- Reconcile runs inside health (registry seeded on first health call).
- Suggestions actionable (rename hint for typo, maxOpen hint for over).

### `test/panel-data.test.mts` (extend, +~10)
- `projectsOverview` → panel rows rendering (markers `OVER`, `?typo`).
- Action submenu options per project (Rename/Set maxOpen/Filter).
- `(no project)` summary row, no submenu.
- (Panel interactive flows — Rename via inline Input, Set maxOpen — are NOT unit-tested; covered by the autonomous tmux QA harness per v0.3.1 pattern. `panel.ts` is the only non-unit-tested component, same as v0.3.0/v0.3.1.)

### Existing suites — regression
- `todo-store` (44), `todo-title-notes` (31), `todo-archive` (55), `todo-config` (15), `todo-migrate` (26), `todo-hard-prune` (16), `todo-auto-prune` (12) — **unchanged logic**, must stay green. `todo-config` gains the new `perProjectDefaultMax` field assertion (default 8 + merge for old configs).

---

## 7. Implementation plan (high-level, for writing-plans)

1. `src/registry.ts` + `test/registry.test.mts` — registry load/save/reconcile/setMaxOpen/rename. Pure, no pi.
2. `src/projects.ts` + `test/projects.test.mts` — overview + Levenshtein typo helper.
3. `src/config.ts` — add `perProjectDefaultMax` (default 8) + `DEFAULT_CONFIG` + merge test.
4. `src/health.ts` + extend `test/todo-health.test.mts` — 4 per-project flags + `projects[]` + `noProject` + actionable suggestions; reconcile-first.
5. `extensions/todo.ts` — tool `projects` + `project_rename` actions; `/todo projects` slash; panel `Projects` tab (rows, action submenu, inline Rename/Set maxOpen/Filter).
6. `src/panel-data.ts` + extend `test/panel-data.test.mts` — `projectsOverview` → panel row helpers, action-submenu options, `(no project)` row.
7. `README.md` + `AGENTS.md` — v0.4.0 section (projects view, rename, per-project health flags, `maxOpen` advisory); Known issues (no enforcement until v0.5.0).
8. RECTOR QA gate (autonomous tmux harness per v0.3.1): panel Projects tab, Rename (incl. merge), Set maxOpen, `/todo projects`, `todo health` per-project section, `/todo project*` slash absence.
9. Merge → tag `v0.4.0` → CI auto-publish npm + GitHub Release.

---

## 8. Out of scope (v0.5.0 / later)

- **Enforcement** — block-on-add when open > maxOpen (v0.5.0 graduates the `PROJECT_OVER` flag → throw).
- **Notes cap** — `maxNotesBytes` config + reject oversize notes at `add`/`update` (v0.5.0).
- **Over-cap injection summary** — `renderOpenBlock` over-cap truncation (counts + over-budget projects instead of the 15-row list) (v0.5.0).
- **Project merge as a distinct action** — v0.4.0 merge is a side-effect of rename-onto-existing; a dedicated `project_merge` (merge N → 1) is later if needed.
- **Project delete/purge** — removing a registry entry without renaming (orphaned todos keep their `project` string; re-registered on next read). Later.
- **Per-project `maxNotesBytes`** — v0.5.0 may add this to the registry entry (schema v2).

---

## 9. Backwards compatibility

- **Store:** `Store.version: 3` unchanged. No migration. Existing `todo.json` + `todo-archive.json` load as-is.
- **Config:** `TodoConfig.version: 1` unchanged. `perProjectDefaultMax` added via forward-compatible merge (old configs get the default 8).
- **Registry:** new file; missing on first load → empty → seeded lazily. No user action.
- **`project` free-text:** unchanged. Existing todos with any `project` string keep working; the registry picks them up on first read.
- **Injection (`## Open TODOs`):** unchanged in v0.4.0.
- **Tool API:** two new `action` values (`projects`, `project_rename`); no existing action changes.
- **Slash:** one new sub (`/todo projects`); no existing sub changes.

No breaking changes. v0.3.1 → v0.4.0 is a safe in-place upgrade.