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

The only irreversible action is `prune --hard` (SPEC-2, not yet shipped) — it
requires an explicit `confirm: true` and is always user-confirmed.

**Storage layout:**

```
~/.pi/agent/todo/
  todo.json              # active + parked
  todo-archive.json      # done + cancelled (sealed history)
  todo.config.json       # prune ages + health thresholds
```

A v1 single-file store at `~/.pi/agent/todo.json` is migrated automatically on
first load after upgrade.

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
/todo add <text>         quick add (priority: med)
/todo done <id>          mark done
/todo rm <id>            cancel (tombstone)
/todo park <id>          defer (parked — not injected, recoverable)
/todo restore <id>       bring an archived todo back as open
/todo prune [--all]      move done/cancelled to archive (reversible)
/todo archive [filter]   archive summary, or filtered slice (project:X / text:Y)
/todo clean              clear all done (deprecated — use prune)
/todo path               show the store file path
```

**The `todo` tool** (model-callable):

| action | params | effect |
|---|---|---|
| `list` | `statusFilter?`, `projectFilter?`, `tagFilter?`, `text?`, `since?`, `before?`, `limit?`, `page?`, `archived?` | matching TODOs (default: open + in_progress). `archived:true` queries the archive — bare call returns a summary, filters return paginated slices |
| `add` | `text`, `project?`, `tags?`, `priority?`, `source?` | create a TODO |
| `update` | `id`, `text?`, `priority?`, `status?`, `project?`, `tags?` | edit a TODO (set `status: parked` to defer) |
| `complete` | `id` | mark done |
| `delete` | `id` | cancel (tombstone) |
| `park` | `id` | defer (parked — not injected) |
| `prune` | `ageDays?`, `all?` | move done/cancelled to archive (reversible via restore) |
| `restore` | `id` | bring an archived TODO back as open |
| `clear` | `status?` (default `done`) | bulk-clear a status (deprecated — use prune) |

Each TODO carries `id, text, project, tags, priority (low|med|high|critical), status (open|in_progress|parked|done|cancelled), source, createdAt, updatedAt, closedAt`.

## How it works

- **Disk store** — `~/.pi/agent/todo/` folder: `todo.json` (live: active + parked), `todo-archive.json` (sealed: done + cancelled), `todo.config.json` (prune ages + health thresholds). Atomic `0600` writes, corrupt-file auto-recovery, `version: 2` schema. Not pi session entries, so it outlives any conversation.
- **`todo` tool** — model CRUD + lifecycle (above).
- **`/todo` command** — human triage (above).
- **Auto-inject** — on every `before_agent_start`, a compact `## Open TODOs (N)` block (titles + ids, capped at 15, sorted by priority) is appended to the system prompt, so the agent starts every turn already aware of pending work. Only `open` + `in_progress` are injected — `parked` and archived todos are excluded (the lifecycle-box boundary). Mutations refresh it on the next turn.
- **Archive query** — `list` with `archived:true` is summary-first (counts by project + month) then filtered/paginated on demand, so a large archive never bloats a single query.

Full design + decisions: [`docs/superpowers/specs/2026-07-20-lifecycle-boxes-prune-design.md`](docs/superpowers/specs/2026-07-20-lifecycle-boxes-prune-design.md). Original v0.1.0 spec: [`docs/todo-SPEC.md`](docs/todo-SPEC.md).

## Configuration

| env var | default | purpose |
|---|---|---|
| `TODO_DIR` | `~/.pi/agent/todo/` | override the store folder (tests / multiple profiles) |

Run the store tests: `npm test` (95/95 across `todo-store` + `todo-archive` + `todo-config` + `todo-migrate`).

## Security

- Store file is `0600`. Atomic write (temp + rename); a corrupt file is backed up to `todo.json.bad-<ts>` and a fresh store starts — the extension never crashes your session.
- **Never put secrets in a TODO.** TODO text is injected into the system prompt and therefore reaches your model provider — same rule as `AGENTS.md` / context files.

## License

MIT.