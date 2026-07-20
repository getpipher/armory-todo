# DESIGN — armory-todo: Lifecycle Boxes + Prune + Health (Workstream A)

**Repo:** `getpipher/armory-todo` (`~/local-dev/getpipher/armory-todo`)
**Status:** Approved 2026-07-20 (brainstormed with RECTOR via the superpowers `brainstorming` skill).
**Supersedes (for the areas it covers):** the prune/growth notes in `docs/todo-SPEC.md` §8 ("Unbounded growth").
**Related issue:** [getpipher/armory-todo#1](https://github.com/getpipher/armory-todo/issues/1) — the reactive (health/suggestions) half of issue #1 is satisfied by SPEC-2 of this workstream. The preventive half (caps-on-add hard-block + project registry) remains out of scope, deferred to a future Workstream C.

---

## 1. Problem

`armory-todo` v0.1.0 is a flat "open/done" list backed by a single JSON file. After ~5 weeks of real use across multiple projects, the store reached **728 lines / 52KB / 47 todos**:

- **35 done/cancelled** todos (~23KB, 67% of the file) sit forever in `todo.json`. `clearTodos` hard-deletes them but is all-or-nothing and lossy — no archive, no age-based policy, no recovery — so it's never run.
- **12 open/in_progress** todos (~12KB) are auto-injected into the system prompt every turn. Several are long-running work logs (one is 3.8KB in a single `text` string) the user isn't actively working on, but there's no "deferred/someday" state — the only options are `open` (context noise) or `cancel` (feels like throwing it away).

Two root gaps:
1. **No lifecycle beyond open→done.** No home for "I don't know when I'll work on this" work, and no sealed history for finished work.
2. **No self-awareness.** Nothing detects bloat, nothing suggests cleanup, the auto-injected block grows without bound.

## 2. Goal & non-goals

**Goal:** turn `armory-todo` from a flat list into a **lifecycle-box system** where:
- the agent context sees only the **active** working set (open + in_progress),
- nothing is ever deleted by default — every state is reversible,
- there's a **parked** state for deferred/someday work (preserved, not injected, one flip from active),
- finished work moves to a sealed **archive** (recoverable, not injected, queryable on demand),
- the agent **proactively surfaces bloat** and proposes **user-confirmed** hard-prune.

**Non-goals (separate workstreams):**
- **Workstream B** — `title` + `notes`/`log` schema split. The per-todo text bloat (a 3.8KB `text` string) is a separate problem from the *count* of todos; parking reduces count, not per-todo size. B is its own spec.
- **Workstream C** — preventive caps-on-add + project registry (issue #1's hard-block half + `projects` action). This workstream delivers the *reactive* self-awareness half of issue #1; the *preventive* caps half stays for C.

## 3. Architecture — lifecycle boxes

Three logical boxes, realized as two files + one status value:

```
                         ┌─────────────────────────────────────────┐
                         │  todo.json (live)                        │
                         │   open ──ip──▶ in_progress               │
                         │    ▲               │                    │
                         │    │               │ complete           │
                         │   park            done                  │
                         │    │               │                    │
                         │  parked ◀──────────┘ (cancel from any)  │
                         └───┬───────────────┬──────────────────────┘
                             │ prune (age)   │ restore
                             ▼               │
                         ┌─────────────────────────────────────────┐
                         │  todo-archive.json (sealed)              │
                         │   done, cancelled                        │
                         │      │                                   │
                         │      │ prune --hard --confirm             │
                         │      ▼                                   │
                         │   (deleted — the only irreversible path) │
                         └─────────────────────────────────────────┘
```

**Auto-injection boundary (the core anti-bloat guarantee):**

| File | Contents | Auto-injected into prompt? |
|---|---|---|
| `todo.json` | `open` + `in_progress` | ✅ Yes — via `renderOpenBlock`, unchanged logic (open+in_progress filter, capped 15, sorted priority→createdAt) |
| `todo.json` | `parked` | ❌ No — excluded by the existing open+in_progress filter |
| `todo-archive.json` | `done` + `cancelled` | ❌ No — separate file, never read by the injector |

`parked` is automatically excluded from injection because it's neither `open` nor `in_progress` — no injection logic change needed. The archive is a separate file the injector never touches.

## 4. Storage layout

```
~/.pi/agent/todo/
  todo.json              # live store: open, in_progress, parked
  todo-archive.json      # sealed history: done, cancelled (moved here by prune)
  todo.config.json       # prune ages, bloat thresholds (editable)
```

Env var for tests: `TODO_DIR` (default `~/.pi/agent/todo/`). The legacy `TODO_STORE_PATH` (file path) is retired; tests are updated to set `TODO_DIR` to a temp dir.

**Migration (one-time, on first load after upgrade):** if `~/.pi/agent/todo.json` (old single-file) exists and `~/.pi/agent/todo/` does not → create the folder, move the old file to `todo/todo.json`, write a default `todo.config.json`, leave `todo-archive.json` empty (done/cancelled stay in `todo.json` until the first `prune` relocates them). The move is atomic with a `.bak-<ts>` backup on failure; never leave the store orphaned.

## 5. Data model

### `Todo` (one field changed: status enum widened)

```ts
type Status = "open" | "in_progress" | "parked" | "done" | "cancelled";
```

All other fields unchanged from v0.1.0: `id`, `text`, `project`, `tags`, `priority`, `source`, `createdAt`, `updatedAt`, `closedAt`. `closedAt` is set on transition to `done`/`cancelled` and cleared on any transition back to a non-terminal state (including `restore` from archive → `open`).

### `todo.json` (version bumped to 2)

```jsonc
{ "version": 2, "updatedAt": "...", "todos": [ /* open + in_progress + parked only */ ] }
```

After a `prune`, `done`/`cancelled` are not allowed to persist here — they live in the archive. (Pre-prune, a freshly-completed todo still sits here with `closedAt` set until the next prune relocates it — this is the "recently closed" tail.)

### `todo-archive.json` (new)

```jsonc
{ "version": 2, "updatedAt": "...", "todos": [ /* done + cancelled only */ ] }
```

Same `Todo` schema. Append-only on prune; entries are removed only by `restore` (→ back to `todo.json` as `open`) or `prune --hard` (→ deleted).

### `todo.config.json` (new)

```jsonc
{
  "version": 1,
  "prune": {
    "defaultAgeDays": 7,
    "hardAgeDays": 180,
    "statuses": ["done", "cancelled"]
  },
  "health": {
    "activeMaxOpen": 15,
    "activeStaleDays": 30,
    "parkedMax": 10,
    "parkedStaleDays": 60,
    "archiveMax": 200,
    "archiveOldDays": 180
  }
}
```

All values editable (via the SPEC-3 Config panel or by hand). Missing file → defaults written on first load. Corrupt file → back up to `todo.config.json.bad-<ts>` and rewrite defaults (same pattern as store corruption handling).

## 6. Lifecycle transitions

| From | To | Action | Effect |
|---|---|---|---|
| `open`/`in_progress` | `parked` | `park <id>` (or `update --status parked`) | status flip, same file, `closedAt` cleared |
| `parked` | `open` | `update --status open` | status flip, same file |
| `open`/`in_progress`/`parked` | `done` | `complete <id>` | sets `closedAt`, stays in `todo.json` until pruned |
| any non-terminal | `cancelled` | `delete <id>` | sets `closedAt`, stays in `todo.json` until pruned |
| `done`/`cancelled` (in `todo.json`) | archive | `prune` (age-based or `--all`) | **moves** the todo from `todo.json` → `todo-archive.json` |
| archived | `open` (in `todo.json`) | `restore <id>` | **moves** back to `todo.json`, `status: open`, `closedAt: null` |
| archived | deleted | `prune --hard --confirm` | **the only irreversible action** — removes from archive permanently |

Everything is reversible except `prune --hard`. Prune (archive move) is reversible via `restore`. Park is reversible via a status flip. Complete/delete are reversible via `restore` after prune, or via status flip before prune.

## 7. Tool API (`todo`) — new + changed actions

| action | params | behavior |
|---|---|---|
| `list` (extended) | `status?`, `project?`, `tag?`, **`archived?: boolean`**, **`since?`**, **`before?`**, **`text?: string`** (substring search), **`limit?: number`** (default 20), **`page?: number`** | `archived:false` (default) queries `todo.json`; `archived:true` queries `todo-archive.json` with filters + pagination. Bare `archived:true` with no other filter → returns a **summary** (counts by project + by month), not raw entries (Q2 — cheap overview). Any filter → filtered, paginated slice (Q1 + Q3). |
| `add` (unchanged) | `text`, `project?`, `tags?`, `priority?`, `source?` | |
| `update` (extended) | + `status: "parked"` accepted | |
| `complete` / `delete` (unchanged) | `id` | |
| **`park`** (new) | `id` | shorthand for `update --status parked` |
| **`prune`** (new) | `age?: number` (default from `config.prune.defaultAgeDays`), `all?: boolean`, `statuses?: Status[]` | moves qualifying `done`/`cancelled` from `todo.json` → `todo-archive.json`. Qualifying = `closedAt` older than `age` days, OR `all:true`. Returns count moved + ids. **Reversible** via `restore`. |
| **`restore`** (new) | `id` | moves an archived todo back to `todo.json` as `open` (`closedAt: null`). Errors if the id is not in the archive. |
| **`prune --hard`** (new) | `box?: "archive"\|"active"\|"parked"`, `olderThan?: number` (days), `project?`, `tag?`, **`confirm: boolean`** (required) | **The only deletion path.** Refuses to execute unless `confirm: true` is passed in the tool call. Returns count + ids deleted. |
| **`health`** (new) | (none) | returns the bloat report (§8). Pure read, no side effects. |
| `clear` (existing) | `status?` | **deprecated** — its two use cases are now better served separately: reversible bulk-close → `prune --all` (archives); irreversible bulk-delete → `prune --hard --confirm` (deletes). Kept for back-compat one release, then removed. |

## 8. `health` bloat report

```
todo health →
{
  active:   { open: 12, in_progress: 3, stale_30d: 6 },
  parked:   { count: 9, stale_60d: 4 },
  archive:  { count: 247, older_180d: 41 },
  flags:    ["ACTIVE_STALE", "PARKED_STALE", "ARCHIVE_LARGE"],
  suggestions: [
    "archive: 41 items older than 180d → consider `prune --hard --box archive --older-than 180 --confirm`",
    "active: 6 open TODOs untouched for 30d → park or close them",
    "parked: 4 parked > 60d → restore or hard-prune"
  ]
}
```

**Bloat heuristics (defaults from `todo.config.json` → `health` block):**

| Box | Signal | Threshold | Flag |
|---|---|---|---|
| active | too many open | `open + in_progress > activeMaxOpen` (15) | `ACTIVE_LARGE` |
| active | stale | `open` with `updatedAt > activeStaleDays` (30d) | `ACTIVE_STALE` |
| parked | too many parked | `parked > parkedMax` (10) | `PARKED_LARGE` |
| parked | stale parked | `parked` with `updatedAt > parkedStaleDays` (60d) | `PARKED_STALE` |
| archive | large | `count > archiveMax` (200) | `ARCHIVE_LARGE` |
| archive | very old | `closedAt > archiveOldDays` (180d) | `ARCHIVE_OLD` |

The agent is instructed (prompt guidelines on the `todo` tool) to run `health` when the user asks about hygiene/bloat, and to **surface suggestions + wait for explicit user confirmation** before any `prune --hard`.

## 9. Hard-prune gate (the only irreversible action)

Two layers of protection:

1. **Tool-level (structural):** `prune --hard` refuses to execute unless `confirm: true` is passed in the tool call. Even if the agent hallucinates intent, the tool demands the flag. Without it, returns: `"Refused: pass confirm:true to execute hard-prune (this permanently deletes N todos)."`
2. **Prompt-level (behavioral):** the `todo` tool description + prompt guidelines instruct the agent to *always* surface the `health` report + the exact proposed `prune --hard` command, and wait for an explicit user "yes" before passing `confirm: true`.

The slash-command path uses `ctx.ui.confirm` (interactive yes/no prompt) as its gate — the human confirms in-TUI before the command executes.

## 10. Slash command (`/todo`) — typed subcommands + interactive panel

### Typed subcommands (power-user, all SPEC-1/2; the interactive panel is SPEC-3)

- `/todo` — open + in_progress (existing default).
- `/todo all` — existing, now also shows `parked`.
- **`/todo park <id>`** — park a todo.
- **`/todo restore <id>`** — restore from archive.
- **`/todo prune`** — age-based prune (default 7d). Confirms count before moving.
- **`/todo prune --all`** — prune all done/cancelled regardless of age.
- **`/todo prune --hard <opts>`** — hard-prune; slash path always prompts `ctx.ui.confirm` first.
- **`/todo archive`** — archive summary (counts by project + month).
- **`/todo archive <filter>`** — filtered archive slice (e.g. `/todo archive project:nuntius`).
- **`/todo health`** — print the bloat report.
- `/todo add` / `/todo done` / `/todo rm` / `/todo path` — existing, unchanged.

### Interactive panel (SPEC-3) — adopts the `/cursor` + `/vision` pattern

Built on **pi-tui** (`Container` + `DynamicBorder` + `Spacer` + `Text` + `SelectList` + `Input` + `SettingsList`) inside `ctx.ui.custom()`, matching the conventions of `@getpipher/cursor` and `@getpipher/vision`:

- **TUI-only panel**; non-TUI (`ctx.mode !== "tui"`) falls back to `ctx.ui.notify` text status.
- **`Container` + `DynamicBorder` (accent) + `Spacer` + `Text`** framing (accent border top + bottom — matches `/settings`).
- **`SelectList` + `Input` filter** for the todo list (the `VisionModelPicker` search pattern), **`SettingsList`** for the Config view.
- **Live apply + persist** on each change (writes `todo.json` / `todo-archive.json` / `todo.config.json` immediately, like `/vision` writes `vision.json`).
- **Escape exits**; arrow keys navigate; Enter selects/edits/opens sub-picker.
- **Power-user typed subcommands retained** alongside the panel.

Panel layout:

```
┌ ──────────────────────────────────────────────────── ┐   ← DynamicBorder (accent)

  TODO — Active (12)          [tab: Active | Parked | Archive | Config]
  ⚠ ARCHIVE_LARGE (247) · ACTIVE_STALE (6)  — run /todo health

  🔍 filter:_                                            ← Input (type to search text/project/tag)
  ❯ [td-mrin…] (critical) ⏵ Nuntius — pivoted to web-app…   ← SelectList
    [td-mrr0…] (critical) ZeroClaw×Solana bounty…
    [td-mrau…] (critical) Anamnesis demo: SHIPPED…
    ...
  ↑↓ navigate • enter select • tab box • p park • c done • x rm • h health • esc done
┌ ──────────────────────────────────────────────────── ┐   ← DynamicBorder (accent)
```

**Box tabs (Tab / Shift+Tab cycles):**
- **Active** — `SelectList` of open + in_progress, filter `Input`, row = `[id] (prio) status⏵ text (project)`.
- **Parked** — same layout, parked todos.
- **Archive** — summary-first (counts by project + month) as `SelectList` items; Enter drills into a bucket → filtered slice; Enter on a todo opens restore.
- **Config** — `SettingsList` with `prune.defaultAgeDays`, `prune.hardAgeDays`, `prune.statuses`, and each `health.*` threshold (editable, live-persist to `todo.config.json`).

**On Enter (select a todo):** action submenu (small `SelectList`): Complete / Park / Edit text / Delete / Restore (if archived) / Cancel.

**Keybindings:** `p` park, `c` complete, `x` delete, `r` restore, `h` health, `tab`/`shift+tab` switch box, `esc` done.

## 11. Auto-injection behavior (unchanged logic)

`renderOpenBlock` stays as-is: injects `open` + `in_progress` only, capped at 15, sorted priority → createdAt, overflow → "… +N more". `parked` is automatically excluded (neither open nor in_progress). The archive file is never read by the injector. No injection code change required — the `parked` status is excluded by the existing filter.

**`session_start` notify upgrade (SPEC-2):** the existing open-count notify is extended — if `health` flags any bloat, the notify appends `⚠ N bloat signals — run /todo health`. Cheap nudge, zero prompt cost (it's a UI notify, not a system-prompt injection).

## 12. Edge cases & failure modes

- **Migration failure** — if the folder move fails mid-way, restore the old `~/.pi/agent/todo.json` from the `.bak-<ts>` backup; never leave the store orphaned.
- **Archive file missing** — `prune` creates it on first run; `restore` / `list --archived` on a missing archive returns empty, no error.
- **Config missing/corrupt** — rewrite defaults, back up the bad file (same pattern as store corruption).
- **Concurrent sessions** — same last-write-wins as v0.1.0 (atomic tmp+rename per file). Archive writes are append-only under the same atomic write. No `flock` in this workstream.
- **`restore` of a non-archived id** — error: `"not in archive"` (the store looks in the archive file only).
- **`prune --hard` without `confirm`** — returns: `"Refused: pass confirm:true to execute hard-prune (this permanently deletes)."` (no-op).
- **Segmented archive (future S2)** — the `list --archived` query API (filters + pagination + summary) is the abstraction. Swapping single-file `todo-archive.json` → monthly segments (`archive/2026-07.json`) later doesn't change the tool surface. Out of scope for this workstream.
- **`parked` todos in a fresh v1→v2 migration** — there are none (v1 has no `parked` status); no migration concern.

## 13. Testing

- **Store unit tests (extend the existing `test/todo-store.test.mts`):**
  - `parked` status round-trips (open → parked → open).
  - `prune` moves done/cancelled to `todo-archive.json` by age; `--all` moves all regardless of age; non-terminal statuses are never pruned.
  - `restore` moves an archived todo back to `todo.json` as `open` with `closedAt: null`; errors on a non-archived id.
  - `prune --hard` refuses without `confirm:true` (no-op + refusal message); deletes the matching set with `confirm:true`.
  - `health` returns correct flags + counts for constructed scenarios (active stale, parked stale, archive large/old).
  - `list --archived` with filters returns only matches; bare `--archived` returns a summary; pagination respects `limit`/`page`.
  - `todo.config.json` defaults written when missing; corrupt config → backup + defaults.
  - Migration from v1 single-file (`~/.pi/agent/todo.json`) to v2 folder layout (`~/.pi/agent/todo/todo.json` + default config + empty archive); migration failure → backup restored.
- **Hard-prune gate test:** `prune --hard` without `confirm` is a no-op that returns the refusal message; with `confirm:true` deletes the specified set.
- **Manual gate (real pi session):** park a todo → confirm it drops from the injected `## Open TODOs` block; `prune` → confirm done todos appear in `/todo archive`; `restore` one → confirm it's back in `todo.json` as `open`; `health` → confirm bloat flags render; `prune --hard` without confirm → confirm refusal; with confirm → confirm deletion.

## 14. Out of scope (separate workstreams)

- **Workstream B — `title` + `notes`/`log` schema split.** The per-todo text bloat (a 3.8KB `text` string injected verbatim). Parking reduces the *count* of injected todos, not the per-todo *size*. B is its own spec.
- **Workstream C — preventive caps-on-add + project registry.** Issue #1's *preventive* half (hard-block on `add` that exceeds a cap, `projects` action, optional project registry). This workstream delivers the *reactive* self-awareness half of issue #1 (health + suggestions); the preventive caps half stays for C.

## 15. SPEC-N decomposition (implementation roadmap)

This design is implemented as three SPECs, each independently shippable + reviewable, each with its own plan:

| SPEC | Scope | Builds on | Shippable outcome |
|---|---|---|---|
| **SPEC-1 — Store layer: lifecycle boxes + prune + archive + restore** | Folder layout + v1→v2 migration; `parked` status; `todo-archive.json`; age-based `prune` (+ `--all`); `restore`; `todo.config.json` + defaults; tool actions (`park`, `prune`, `restore`, extended `list` with `--archived`/filters/pagination/summary); typed slash subcommands. Auto-injection unchanged (parked auto-excluded by the existing open+in_progress filter). | — | The bloat fix works day one: `/todo prune` shrinks the 52KB file; `park` drops deferred todos from the prompt. All reversible. |
| **SPEC-2 — Self-awareness: health + hard-prune** | `health` action (bloat report from config heuristics); `prune --hard --confirm` (the only irreversible path, tool-level `confirm` gate + prompt-level "always ask first"); `session_start` bloat nudge; prompt guidelines (agent surfaces health, waits for user yes). | SPEC-1 (health reads the archive prune populates) | Agent proactively surfaces bloat + suggests user-confirmed cleanup. |
| **SPEC-3 — Interactive `/todo` TUI panel** | pi-tui panel (Container + DynamicBorder + SelectList + Input filter); box tabs (Active / Parked / Archive / Config); action submenu on Enter; Config view via `SettingsList` (prune ages + thresholds, live-persist); keybindings; non-TUI fallback; power-user typed subcommands retained. | SPEC-1 + SPEC-2 (panel operates on all primitives) | `/todo` becomes a real triage surface, not a series of typed commands. |

**Order rationale:** SPEC-1 is the load-bearing store work (it's what actually shrinks the file + bounds the prompt) and is fully testable in isolation. SPEC-2 adds the intelligence layer on a proven store. SPEC-3 is the UX layer on top of both — building it last means it wraps a stable primitive surface, so a UI bug is never conflated with a store bug. This mirrors how `@getpipher/cursor` and `@getpipher/vision` each evolved their interactive panels over multiple specs rather than shipping the full panel in v1.

The next step after this design is approved is `writing-plans` for **SPEC-1**.

---

## Appendix A — Decisions log (from the brainstorming session)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| D1 | Workstream scope | A (pruning/GC + archive) first; B (schema split) + C (caps) separate | Pruning is the actual prerequisite for a lean store; caps are shaky without it. |
| D2 | Pruned todos | A1 — move to archive file (`todo-archive.json`) | Done todos are a real work record; archive gives recovery + audit; hard-delete loses history. |
| D3 | Prune policy | P3 — age-based default (7d) + `--all` / `--age N` override flags | Keeps a short "recently closed" tail; escape hatch for full sweeps. |
| D4 | Default prune age | 7 days | Aggressive leanness (israf stance); archive handles all older lookback. |
| D5 | Prune statuses | both `done` and `cancelled` | Both are dead weight; `cancelled` is not used as a soft "parked" (we now have a real `parked` status). |
| D6 | Box model | Approach 2 — single live file + `parked` status + physical archive file | Minimal schema change; parked → active is one status flip; archive is genuinely out of the working file. |
| D7 | Archive injection | never | Archive is read-on-demand only; the agent context sees only open + in_progress. |
| D8 | Archive read scalability | S1 (single JSON) now + Q1/Q2/Q3 query API (filter-first, summary-first, paginated); S2/S3 (segments/SQLite) deferred | Realistic volume is low-thousands; JSON parse is sub-100ms. The query API is storage-agnostic for future swaps. |
| D9 | Self-awareness | reactive (health + suggestions + user-confirmed hard-prune), not preventive caps | Non-blocking + helpful; preventive caps-on-add deferred to Workstream C. |
| D10 | Hard-prune gate | tool-level `confirm: true` flag (structural) + prompt-level "always ask first" (behavioral) + `ctx.ui.confirm` on the slash path | The only irreversible action gets the strongest gate; the tool refuses even if the agent hallucinates. |
| D11 | Config location | C2 — `todo.config.json` in a dedicated `~/.pi/agent/todo/` folder | Co-located with the data; the folder also gives the archive a natural home + room for future segmentation. |
| D12 | Heuristic defaults | active 15 / 30d stale · parked 10 / 60d stale · archive 200 / 180d old | Sensible starting points; all editable in Config. |
| D13 | `/todo` command UX | S2 — interactive TUI panel (adopting the `/cursor` + `/vision` pi-tui pattern) + retained typed subcommands | A real triage surface, not a series of typed commands. |
| D14 | Spec decomposition | 3 SPECs (store / self-awareness / panel), each its own plan | Each independently shippable + testable; panel built on a stable primitive surface. |