# v0.5.0 — Caps Release (Feature B, enforcement)

**Date:** 2026-07-21
**Status:** Approved (brainstorm 2026-07-21, all six decisions = A)
**Issue:** #1 — Project-scope management + self-awareness caps to prevent TODO bloat (Feature B, the forcing-function half)
**Predecessor:** v0.4.0 (project registry + `projects` overview + per-project `health` flags + advisory `maxOpen` slot + rename/merge). Published `@getpipher/armory-todo@0.4.0`.
**Branch:** `feat/caps-release` off `main`
**Semver:** minor (v0.5.0) — a semantic behavior change (advisory `maxOpen` → enforced) plus new enforcement.

---

## 1. Goal

Graduate the v0.4.0 advisory `maxOpen` slot into **enforcement** and add two more caps, so the TODO store (and its auto-injected prompt block) cannot bloat silently. One coherent "caps release," all enforcement:

1. **Count cap** — per-project `maxOpen` → **block-on-add** (and block on project-move into a capped project).
2. **Notes cap** — global `maxNotesBytes` → **reject oversize notes at write time** (mirrors the title cap).
3. **Over-cap injection truncation** — when actionable > `activeMaxOpen`, `renderOpenBlock` switches to a lean summary (counts + over-budget projects + pointer) instead of the row list.

Tune defaults using v0.4.0's real per-project usage data (now visible via `projects`/`health`).

## 2. Decisions (brainstorm, all A)

| Q | Decision | Rationale |
|---|---|---|
| **Q1 enforcement mode** | Enforce explicitly-set per-project `maxOpen` only (hard block-on-add). Defaults (`activeMaxOpen`, `perProjectDefaultMax`) stay advisory. No `force` hatch. Block fires on `add` + project-`move`, **not** un-park. | v0.4.0 already ships warn-only (the flags). Enforcement must enforce *something*. Only an explicitly-set cap enforces — opt-in via setting `maxOpen`. A global hard block is too aggressive; enforcing a *default* is hostile. Un-park ≠ adding. |
| **Q2 global cap** | No new global hard cap. `activeMaxOpen` (=15) stays advisory (`ACTIVE_LARGE`) and gains a second job: the **injection-truncation trigger**. | Global budget is a *signal*, not a *gate*. The global lever acts on the prompt (lean injection), not on `add`. |
| **Q3 notes cap** | Global `health.maxNotesBytes`, default **8192** bytes, hard-reject at `add`/`update` (only when `notes` is written). Grandfather existing. `NOTES_OVER` health flag. Registry schema v1 unchanged. | Notes bloat is per-todo hygiene, not per-project. Active default (8KB ≈ 1–1.5k words) catches pathological agent dumps with no real downside. |
| **Q4 injection truncation** | `renderOpenBlock` becomes cap-aware: trigger = `activeMaxOpen`. Over → lean summary (counts + `PROJECT_OVER` projects only + pointer). Under → rows up to `activeMaxOpen`. | Keeps the over-budget prompt to ~4 lines regardless of bloat — the anti-israf point. Surfaces only real breaches (explicit `maxOpen`), not soft heuristics. |
| **Q5 migration** | Zero. Store v3 unchanged. Config gains `health.maxNotesBytes` via forward-merge (no version bump). Registry v1 unchanged. | Caps are enforcement, not data. |
| **Q6 backwards-compat** | Oversize notes grandfathered (cap on write only). `maxOpen` advisory→enforced is a documented behavior change (minor bump). No v0.4.0 user has capped projects in the known real store, so zero real impact. | Re-setting slots silently is its own surprise. The block message tells users how to raise/clear. |

## 3. Architecture

Caps are an **enforcement layer on top of the existing store** — no new data, no migration. Three enforcement points:

1. **`addTodo`** — title check (existing) + notes-cap check + project-cap check (new), all *before* `store.todos.push` (atomic: no partial write on breach).
2. **`updateTodo`** — notes-cap check (only when `notes` patch present) + project-cap check on a project **move** (only when the moved todo is `open`/`in_progress`).
3. **`renderOpenBlock`** — cap-aware truncation (summary mode when over `activeMaxOpen`).

A new pure module `src/caps.ts` holds the check logic so it's unit-testable without disk. Config gains `health.maxNotesBytes`. Registry unchanged (schema v1). Zero store migration.

## 4. Components

### 4.1 `src/caps.ts` (new, pure — no disk I/O)

```ts
/** Throw if notes exceeds the byte cap. Byte-length (not char-length): notes
 *  can hold Unicode ("é" = 2 bytes UTF-8). */
export function checkNotesCap(notes: string, maxBytes: number): void

/** Throw if adding one more open todo to `project` would exceed its cap.
 *  `maxOpen === null` → no-op (uncapped). `currentOpen` is the project's
 *  current open count, NOT counting the would-be-added todo. */
export function checkProjectCap(opts: { project: string; currentOpen: number; maxOpen: number | null }): void

/** Projects whose open count exceeds their explicit maxOpen (maxOpen non-null).
 *  Pure; consumed by renderOpenBlock summary + health (existing PROJECT_OVER). */
export function overBudgetProjects(liveTodos: Todo[], registry: ProjectRegistry): { name: string; open: number; maxOpen: number }[]
```

Error messages (actionable, surfaced verbatim to the agent/user via the existing `TodoError` → `Error: …` path):

- `project 'X' is at maxOpen 8 (8 open) — close/park one, or raise maxOpen via the /todo panel (Projects tab → Set maxOpen), before adding`
- `notes 9.2KB > max 8KB (maxNotesBytes 8192) — trim the detail or split into multiple todos`

### 4.2 `src/config.ts` (modify)

- Add `health.maxNotesBytes: number` (default `8192`).
- Forward-compatible merge in `loadConfig` (same pattern as `perProjectDefaultMax` in v0.4.0): `{ ...DEFAULT_CONFIG.health, ...parsed.health }`.
- Defensive: non-positive or non-number `maxNotesBytes` → default. (0 is a valid strict "no notes" choice and is respected; negative/NaN/missing → default.)
- **No `TodoConfig.version` bump** (stays 1).

### 4.3 `src/todo-store.ts` (modify)

**`addTodo`:**
- After `normalizeTitle`, load config + registry.
- Count the target project's current `open` (todos with `status === "open"` — new todos are `open`, so `in_progress` isn't relevant for adds; count open only).
- `checkNotesCap(notes, config.health.maxNotesBytes)` then `checkProjectCap({ project, currentOpen, maxOpen })`.
- All checks precede `store.todos.push` → atomic (no partial write on breach).

**`updateTodo`:**
- If `patch.notes !== undefined` → `checkNotesCap(patch.notes.trim(), config.health.maxNotesBytes)`.
- If `patch.project` is set, trimmed, and differs from `todo.project` **and** `todo.status` is `open`/`in_progress` → count the **target** project's open (excluding this todo, which is still in the source project at count time) → `checkProjectCap`.
- Un-park (`parked→open`) is **not** re-checked — reactivation ≠ adding (intentional loophole, documented).

**`renderOpenBlock(max?)`:**
- Read `activeMaxOpen` from config; the `max` param overrides for tests.
- If `actionable.length > activeMaxOpen` → **summary mode** (see §4.4 shape).
- Else list up to `activeMaxOpen` rows (drops the hardcoded `max=15` default; aligns the injection budget to the configured cap).
- The `… +N more` overflow line is removed (summary mode replaces it at the same threshold).

### 4.4 `renderOpenBlock` summary shape

```
## Open TODOs (23) — ⚠ over budget (cap 15)
23 open+in_progress across 5 projects
over-budget: getpither 9/8, sip-protocol 6/5
run `todo list` or `/todo` to see the full list
```

- Line 1: header with total + the breach + cap.
- Line 2: total actionable + project span (distinct projects with any actionable).
- Line 3: **only projects over their explicit `maxOpen`** (the `PROJECT_OVER` set). Format `name open/max`. Omitted entirely if no project is over its own cap (global over but every project within its slot).
- Line 4: the pointer.

`PROJECT_LARGE` (over `perProjectDefaultMax`, advisory) is deliberately **not** surfaced here — keep the lean summary focused on real breaches, not soft heuristics.

### 4.5 `src/health.ts` (modify)

- Add `"NOTES_OVER"` to `HealthFlag`.
- Extend `NotesBytes` with `maxId: string | null` (the id of the worst-offender todo), tracked during the existing reduce over active+parked notes (cheap, no new scan).
- Push `NOTES_OVER` when `notesBytes.max > config.health.maxNotesBytes`.
- Suggestion: `notes: largest note <id> is 12KB > cap 8KB → trim via todo update <id> notes:…` (actionable — names the offender id).

### 4.6 `src/panel-data.ts` (modify)

- Add a Config row for `maxNotesBytes` (editable): label `"Notes max bytes"`, values `["2048","4096","8192","16384","32768"]`, description `"Hard reject at add/update when notes exceeds this (bytes). 0 = no notes."`.
- Projects tab `OVER` marker unchanged — display is cap-agnostic; enforcement is backend.

### 4.7 `extensions/todo.ts` (modify)

- `add`/`update` actions: thrown `TodoError`s already caught + surfaced as `Error: …` — actionable messages flow through unchanged. No new code path needed.
- `before_agent_start`'s `renderOpenBlock()` call: cap-aware now (no call-site change).
- `promptGuidelines`:
  - Update the `add`/`update` line: "adds are blocked if the target project is at its `maxOpen` cap; raise via the panel (Projects tab → Set maxOpen) or close/park one first. Notes are capped at `maxNotesBytes` (default 8KB)."
  - Rewrite the `project_rename` line: remove "enforcement lands in v0.5.0" → "maxOpen caps are enforced (block-on-add)."
- `health` action output: `NOTES_OVER` flows through the generic `flags:` line + the new suggestion line (no special rendering).

### 4.8 `src/panel.ts` (minimal)

No new flows. The Set-maxOpen action already exists; block-on-add surfaces via the tool/slash, not the panel (the panel has no add flow). An "OVER BUDGET" badge on the Active tab header is **YAGNI** — injection + health cover the signal. Skipped.

## 5. Data flow

```
add:  loadStore → loadConfig + loadRegistry → checkNotesCap → checkProjectCap
        → (all pass) push → save   [checks before any mutation = atomic]
update: loadStore → find todo → [if notes patch: checkNotesCap]
        → [if project-move + open/in_progress: checkProjectCap on target] → mutate → save
inject: renderOpenBlock → loadConfig → actionable > activeMaxOpen ?
          summary (counts + overBudgetProjects + pointer) : rows[:activeMaxOpen]
```

## 6. Error handling

- Every cap failure is a `TodoError` thrown **before** any write — the store is never partially mutated (add: checks precede `push`; update: checks precede field mutation).
- Corrupt/missing registry → `loadRegistry` returns empty (existing v0.4.0 behavior) → all `maxOpen` null → **cap fails open** (a bad registry never blocks adds; health flags it separately).
- Corrupt config → `loadConfig` backs up + rewrites defaults (existing) → `maxNotesBytes` defaults to 8192.

## 7. Testing

### 7.1 New `test/todo-caps.test.mts` (~30 tests, temp `TODO_DIR`)

**Notes cap:**
- Oversized `add` throws with actionable message.
- Oversized `update` (with `notes` patch) throws.
- `update` **without** `notes` patch on a grandfathered oversize note survives (no re-check).
- Boundary: exactly `maxBytes` ok; `maxBytes + 1` throws.
- Byte vs char: `"é"` (2 bytes) at `maxBytes: 1` throws; at `maxBytes: 2` ok.
- `notes: ""` always passes (the documented clear path).

**Project cap:**
- Uncapped project (`maxOpen: null`) → add always ok.
- At-cap project (`maxOpen: 8`, open: 8) → add throws.
- One-below (`open: 7`) → add ok (lands at 8, not over).
- Project-move into capped target throws (when moved todo is `open`).
- Project-move of a **parked** todo into capped target → ok (no open impact).
- Same-project "move" (no-op) → ok.
- Un-park (`parked→open`) into a capped project → ok (intentional, not blocked).
- Error message includes the raise/clear hint.

**`renderOpenBlock`:**
- Under cap → row list (capped at `activeMaxOpen`).
- Over cap → summary with over-budget line.
- Over cap but no per-project breaches → summary without the over-budget line.
- Custom `max` param overrides `activeMaxOpen`.

### 7.2 Extend `test/todo-config.test.mts`

- `maxNotesBytes` default 8192.
- Forward-merge: old config without `maxNotesBytes` gets the default.
- Negative/NaN/missing → default; `0` respected.

### 7.3 Extend `test/todo-health.test.mts`

- `NOTES_OVER` flag + suggestion when `notesBytes.max > maxNotesBytes`; suggestion names the offender `maxId`.
- Absent when under.

### 7.4 Extend `test/panel-data.test.mts`

- `maxNotesBytes` config row present in `configToSettingItems`.

**Total:** 331 baseline → ~361–371.

## 8. Edge cases & resolved sub-questions

- **`maxNotesBytes = 0`** → empty notes (0 bytes) pass, any non-empty fails. Valid strict choice; respected. Negative/non-number → default at load.
- **Un-park into a capped project** is an intentional loophole — the cap gates *new* work, not reactivation. Documented in README + promptGuidelines.
- **`update` that only edits `title`** on a grandfathered oversize note: no `notes` patch → no re-check → edit succeeds. (Without this gating, a cap would trap unrelated edits.)
- **`renderOpenBlock` does 2 extra reads/turn** (config + registry). Negligible (tiny JSON files, already reads the store).
- **Byte vs char length:** title uses char length (`.length`); notes uses byte length (`Buffer.byteLength`). Documented distinction — the field is `maxNotesBytes`.
- **Worst-offender id in `NOTES_OVER` suggestion:** `NotesBytes` gains a `maxId: string | null` field, tracked during the existing reduce over active+parked notes (cheap, no new scan). The suggestion names the offender id so it's actionable (`todo update <id> notes:…`).

## 9. Backwards-compat & upgrade notes

- **Zero migration.** Store v3, config v1, registry v1 all unchanged in shape.
- **Oversize existing notes:** grandfathered. Cap fires only when `notes` is written.
- **`maxOpen` advisory → enforced:** semantic behavior change for any v0.4.0 user who set a slot. The known real store has none set (all `null`), so zero real impact. Documented trajectory. Block message tells the user how to raise/clear. Minor version bump (v0.5.0) is the semver signal.
- **README upgrade note** added: a short "v0.5.0" section noting the advisory→enforced graduation + the new notes cap default.

## 10. Flow (same as v0.4.0)

brainstorm ✅ → spec (this doc) → RECTOR reviews → writing-plans → executing-plans (inline; pi has no subagent tool) → self-review (fresh-eyes over `git diff`) → autonomous tmux QA (temp `TODO_DIR` for write ops; real-store read-only for final verify — **do not** run rename/setmax/block-on-add against RECTOR's real store) → merge → tag `v0.5.0` → CI auto-publish npm + GitHub Release → `pi install npm:@getpipher/armory-todo@0.5.0` → memory `v0.5.0-shipped.md`.

## 11. Constraints

- Backwards-compatible with v0.4.0 stores (v3 store, v1 config, v1 registry).
- Zero runtime deps (node:fs only). 2-space indent. No TODO/FIXME. No AI attribution.
- Tests: node:test via tsx. `npm test` must stay green (331 baseline + new).
- Commits: `feat(scope): …` per task. PR → `--merge --delete-branch`.
- getpither UX mental model (in `~/local-dev/getpipher/AGENTS.md`): interactive first (panel) for humans, CLI-style (tool actions) for the agent. New enforcement surfaces (block-on-add error, over-cap injection summary) follow this — the error is the agent's programmatic surface; the panel needs no add flow.