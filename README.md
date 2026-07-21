<p align="center">
  <img src="assets/hero.svg" alt="armory-todo — global, cross-session TODO for pi" width="100%">
</p>

<h1 align="center">armory-todo</h1>

<p align="center">
  A TODO list that <strong>survives across all your pi sessions</strong> — not just within one.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@getpipher/armory-todo"><img src="https://img.shields.io/npm/v/@getpipher/armory-todo?color=cb3837&logo=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/pi-package-34d399" alt="pi-package">
  <img src="https://img.shields.io/badge/license-MIT-22d3ee" alt="MIT">
  <img src="https://img.shields.io/badge/dependencies-0-9aa7a1" alt="no dependencies">
</p>

---

## The problem

pi sessions are ephemeral conversation branches. A TODO you tell to session A is invisible to session B unless you manually write it to a notes file *and* remember to read it next time. Every existing pi todo extension (`@juicesharp/rpiv-todo`, `@xynogen/pix-todo`, `@gonrocca/zero-pi-todo`, …) is **conversation-branch-scoped** — they persist via pi's `appendEntry()` and survive compaction + `/reload` *within a single session*. None bridge across separate sessions, and none make a fresh session aware of pending work on its own.

`armory-todo` is the other shape: a single disk file that **every** session reads, plus an **auto-injected** `## Open TODOs` block in the system prompt so a fresh session starts already aware.

| | survives compaction/reload *within* a session | survives across *separate* sessions | auto-surfaced in every new session |
|---|:---:|:---:|:---:|
| branch-scoped todo extensions | ✅ | ❌ | ❌ |
| **armory-todo** | ✅ | ✅ | ✅ |

## Install

```bash
pi install git:github.com/getpipher/armory-todo      # from git
pi install npm:@getpipher/armory-todo                 # from npm (scoped)
```

Then restart pi (or `/reload`). Or add to `~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:@getpipher/armory-todo"] }
```

## Lifecycle boxes (v0.2.0)

TODOs live in one of three states, only one of which hits the agent context:

| Box | Status(es) | Auto-injected? | Recoverable? |
|---|---|:---:|:---:|
| **Active** | `open`, `in_progress` | ✅ Yes (capped 15) | n/a |
| **Parked** | `parked` | ❌ No | ✅ `update --status open` |
| **Archive** | `done`, `cancelled` | ❌ No | ✅ `restore <id>` |

**Pruning:** `prune` (default: done/cancelled older than 7 days) moves finished
todos from the live file to `todo-archive.json` — nothing is deleted. `prune --all`
ignores age. `restore <id>` brings an archived todo back as `open`.

**Auto-prune (v0.3.1):** on every `session_start`, done/cancelled todos older
than `config.prune.defaultAgeDays` (default 7d) archive *themselves* — no need
to run `prune` manually. Fresh done (<7d) stays in live. The startup notify
reports what moved (`auto-pruned N stale done (>7d): …` + a `restore` hint);
it's a transient message, not a prompt injection. Reversible via `restore <id>`.
`prune --all` (move fresh done too) and `prune --hard` (irreversible) stay manual.

The only irreversible action is `prune --hard` (hard-prune) — it requires an
explicit `confirm: true` and is always user-confirmed. See **Self-awareness**
below.

**Storage layout:**

```
~/.pi/agent/todo/
  todo.json              # active + parked
  todo-archive.json      # done + cancelled (sealed history)
  todo.config.json       # prune ages + health thresholds
```

A v1 single-file store at `~/.pi/agent/todo.json` is migrated automatically on
first load after upgrade.

## Self-awareness: health + hard-prune

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

## Title + notes (v0.3.0)

The single `text` field is split into **`title`** (≤120 chars, one-line summary — the only thing injected into the prompt or shown in compact lists) and **`notes`** (any length, the running detail/log — never auto-injected). A hard cap rejects `title` >120 chars at `add`/`update` so the junk-drawer pattern can't re-form. `list` shows titles + a `•` marker when notes exist; `get <id>` reads a todo's full notes before acting on it. v2 `text`-only stores migrate on first load (curated for the 2 known todos + a first-line fallback).

## Interactive panel (SPEC-3)

Run `/todo` (no arg) in a TUI session to open the interactive triage panel:

- **Box tabs** (Tab / Shift+Tab): Active · Parked · **Done** · Archive · Config
- **Filter input**: type to search by text (live filter)
- **SelectList**: arrow keys navigate, Enter selects
- **Action submenu** (on Enter): View detail / Complete / Park / Re-activate / Restore / Edit title / Delete
- **Done tab** (v0.3.1): all finished work (`status: done`) unified across live + archive, location-tagged (`[live Nd]` / `[archived YYYY-MM-DD]`), filterable; Enter → View detail, or Restore-from-archive. Excludes `cancelled` (that's in the Archive tab).
- **Detail view** (View detail, or Enter on a row): renders the title + full `notes` read-only, with a footer hint on editing notes via the `todo` tool
- **Archive box**: summary-first (counts by project + month) → Enter on a bucket to drill down
- **Config box**: SettingsList with prune ages + health thresholds — edit live, persists to `todo.config.json`
- **Escape**: exit the panel

Typed subcommands (`/todo park <id>`, `/todo prune`, etc.) all still work alongside the panel. Non-TUI sessions (`pi -p`, RPC) fall back to the text list.

## Usage

**Say it naturally** — the model calls the `todo` tool:

> “put this in our TODO: decouple global rules into AGENTS.md”
> “show me the TODO” → “mark td-… done”
> “park td-… for now” → later: “restore td-…”
> “prune the done todos”

**Slash command** for quick human triage:

```
/todo                    list open + in-progress TODOs
/todo all                include parked/done/cancelled
/todo add <title>        quick add (priority: med; notes via the todo tool)
/todo finished            list all done todos (live + archived, recent first)
/todo done <id>          mark done
/todo rm <id>            cancel (tombstone)
/todo park <id>          defer (parked — not injected, recoverable)
/todo restore <id>       bring an archived todo back as open
/todo prune [--all]      move done/cancelled to archive (reversible)
/todo prune --hard        permanent deletion (interactive confirm prompt)
/todo archive [filter]   archive summary, or filtered slice (project:X / text:Y)
/todo health              bloat report across all boxes + flags + suggestions
/todo clean              clear all done (deprecated — use prune)
/todo path               show the store file path
```

**The `todo` tool** (model-callable):

| action | params | effect |
|---|---|---|
| `list` | `statusFilter?`, `projectFilter?`, `tagFilter?`, `text?`, `since?`, `before?`, `limit?`, `page?`, `archived?` | matching TODOs (default: open + in_progress). `archived:true` queries the archive — bare call returns a summary, filters return paginated slices |
| `add` | `title`, `notes?`, `project?`, `tags?`, `priority?`, `source?` | create a TODO (`title` ≤120 chars; long detail goes in `notes`) |
| `get` | `id` | read a TODO's full record incl. `notes` |
| `update` | `id`, `title?`, `notes?`, `priority?`, `status?`, `project?`, `tags?` | edit a TODO (set `status: parked` to defer; `notes=""` clears) |
| `complete` | `id` | mark done |
| `delete` | `id` | cancel (tombstone) |
| `park` | `id` | defer (parked — not injected) |
| `prune` | `ageDays?`, `all?` | move done/cancelled to archive (reversible via restore) |
| `restore` | `id` | bring an archived TODO back as open |
| `health` | (none) | bloat report across active/parked/archive + flags + suggestions |
| `prune` (hard) | `hard:true`, `confirm:true`, `box?`, `olderThan?`, `project?`, `tag?` | PERMANENT deletion — the only irreversible action |
| `clear` | `status?` (default `done`) | bulk-clear a status (deprecated — use prune) |

Each TODO carries `id, title (≤120 chars), notes (any length), project, tags, priority (low|med|high|critical), status (open|in_progress|parked|done|cancelled), source, createdAt, updatedAt, closedAt`. The auto-injected block + list/panel show `title` only; `notes` is read via `get` and never injected.

## How it works

- **Disk store** — `~/.pi/agent/todo/` folder: `todo.json` (live: active + parked), `todo-archive.json` (sealed: done + cancelled), `todo.config.json` (prune ages + health thresholds). Atomic `0600` writes, corrupt-file auto-recovery, `version: 3` schema (`title` ≤120 chars + `notes` any length; v2 `text`-only stores migrate to v3 on first load). Not pi session entries, so it outlives any conversation.
- **`todo` tool** — model CRUD + lifecycle (above).
- **`/todo` command** — human triage (above).
- **Auto-inject** — on every `before_agent_start`, a compact `## Open TODOs (N)` block (titles + ids, capped at 15, sorted by priority) is appended to the system prompt, so the agent starts every turn already aware of pending work. Only `open` + `in_progress` are injected — `parked` and archived todos are excluded (the lifecycle-box boundary). Mutations refresh it on the next turn.
- **Archive query** — `list` with `archived:true` is summary-first (counts by project + month) then filtered/paginated on demand, so a large archive never bloats a single query.

Full design + decisions:
- v0.3.0 (title + notes split): [`docs/superpowers/specs/2026-07-21-title-notes-split-design.md`](docs/superpowers/specs/2026-07-21-title-notes-split-design.md)
- v0.2.0 (lifecycle boxes + prune + health): [`docs/superpowers/specs/2026-07-20-lifecycle-boxes-prune-design.md`](docs/superpowers/specs/2026-07-20-lifecycle-boxes-prune-design.md)
- Original v0.1.0 spec: [`docs/todo-SPEC.md`](docs/todo-SPEC.md)

## Configuration

| env var | default | purpose |
|---|---|---|
| `TODO_DIR` | `~/.pi/agent/todo/` | override the store folder (tests / multiple profiles) |

Run the store tests: `npm test` (255/255 across 9 suites).

## Known issues

- **No in-panel multi-line `notes` editing.** The panel's inline Edit is single-line (`Input`) for `title` only; `ctx.ui.editor()` from inside `ctx.ui.custom()` triggers a nested-UI bug (`/todo` won't reopen). `notes` is model-managed via the `todo` tool (`action: update, id, notes`). When a safe `ctx.ui.editor()`-from-`custom()` pattern lands in pi-tui, in-panel notes editing is a clean follow-up.
- **Preventive caps-on-add** (notes length cap + project registry) are deferred to Workstream C (v0.4.0). Until then, `health` reports notes-bytes as a read-only diagnostic.

## Security

- Store file is `0600`. Atomic write (temp + rename); a corrupt file is backed up to `todo.json.bad-<ts>` and a fresh store starts — the extension never crashes your session.
- **Never put secrets in a TODO.** TODO text is injected into the system prompt and therefore reaches your model provider — same rule as `AGENTS.md` / context files.

## License

MIT.