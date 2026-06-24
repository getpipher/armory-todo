# SPEC — `armory-todo` (global, cross-session TODO for pi)

**Repo:** `getpipher/armory` (`~/local-dev/armory`) · **Extension file:** `extensions/todo.ts`
**Status:** Draft (2026-06-23) — pending RECTOR sign-off on the flagged Decisions.
**Related:** closes the "cross-session TODO" pain recorded in `~/Documents/secret/claude-strategy/pi/session-handoff-2026-06-23.md` (Next steps #7 is the canonical TODO this spec exists to never lose again).

---

## 1. Problem

pi sessions are ephemeral conversation branches. A TODO told to session A is **invisible to session B** unless a human manually writes it to a strategy/handoff file *and* the next session remembers to read it. This happened live this week: the "AGENTS.md decoupling" TODO given in `[pi_setup_2]` was unknown to a later session because it lived only in that session's log + a handoff doc the next session hadn't opened.

Existing pi todo extensions (`@juicesharp/rpiv-todo`, `@xynogen/pix-todo`, `@gonrocca/zero-pi-todo`, …) are **conversation-branch-scoped** — they persist via pi's `appendEntry()`/`getBranch()` and survive compaction + `/reload` *within one session*. **None persist across separate sessions**, and none auto-surface open TODOs to a fresh session. (Confirmed by reading their READMEs: *"tasks replay from the conversation branch, not disk."*)

## 2. Goal / non-goals

**Goal:** a persistent, **cross-session**, **agent-accessible** TODO store so that:
- any session can write ("put this in our TODO") and it survives forever (on disk),
- any session can read ("show me the TODO") and get the full global list,
- **every new session is proactively made aware** of open TODOs without being asked (auto-injected into the system prompt).

**Non-goals (v1):**
- Not a project-manager / Gantt / dependency graph. Flat list with tags + priority is enough.
- Not a replacement for per-project `ROADMAP.md` / GitHub issues — those stay the source of truth for *project* scope. `armory-todo` is for **cross-cutting, agent-internal** reminders that don't belong to one repo.
- Not branch-aware replay (that's what existing extensions do; we deliberately use a disk store instead).
- No TUI overlay widget in v1 (a `/todo` command + system-prompt injection suffices; overlay is a later enhancement).

## 3. Architecture

A single pi extension, `extensions/todo.ts`, four parts:

1. **Disk store** — a JSON file, the single source of truth, read/written by every session. NOT pi session entries.
2. **`todo` tool** — LLM-callable; CRUD + filtered list. The model uses this when RECTOR says "put this in our TODO" / "show me the TODO" / "mark X done".
3. **`/todo` slash command** — human-facing triage/view.
4. **Auto-inject** — on `before_agent_start`, append a compact **"Open TODOs"** block to the system prompt so the agent starts every turn already aware of pending work.

```
                 ┌──────────────────────────────────────────────┐
   session A ──▶ │ todo tool ──┐                               │
   session B ──▶ │ /todo cmd ──┼──▶ read/write ──▶ todo.json ◀── │ ──▶ before_agent_start
   session C ──▶ │             │                  (disk)        │      appends "## Open TODOs"
                 │ └───────────┘                               │      to system prompt
                 └──────────────────────────────────────────────┘
```

**Hooks used (pi extension API, verified):**
- `pi.on("session_start", …)` — load store into memory cache; log a notify with the open count.
- `pi.on("before_agent_start", …)` — return `{ systemPrompt: event.systemPrompt + openTodosBlock }` so every agent turn sees the current open list. (Cheap: capped, titles only.)
- `pi.registerTool({ name: "todo", … })` — model CRUD.
- `pi.registerCommand("todo", …)` — human view/filter.

**Why `before_agent_start` (per-prompt) and not `session_start` (once)?** `before_agent_start` is the documented channel to mutate the system prompt (`event.systemPromptOptions.appendSystemPrompt`), and it re-runs after mutations, so the injected list is always current. `session_start` is used only to warm the in-memory cache + notify. We inject on every prompt but the block is tiny (titles + ids, capped at 15) — acceptable overhead. (Decision point: see §7.)

## 4. Data model

Store file: **`~/.pi/agent/todo.json`** (Decision 1). Format:

```jsonc
{
  "version": 1,
  "updatedAt": "2026-06-23T23:41:16Z",
  "todos": [
    {
      "id": "td-01JEXAMPLE",          // ULID-ish, monotonically unique
      "text": "Decouple global rules from CLAUDE.md → per-host AGENTS.md",
      "project": "pi",                // optional, free-form tag (e.g. "pi", "sip", "profizo", or "" for global)
      "tags": ["dotfiles","config"],  // optional
      "priority": "high",             // "low" | "med" | "high" | "critical"
      "status": "open",               // "open" | "in_progress" | "done" | "cancelled"
      "source": "pi_setup_2",         // free-form origin hint (session name / repo)
      "createdAt": "2026-06-23T10:05:00Z",
      "updatedAt": "2026-06-23T10:05:00Z",
      "closedAt": null
    }
  ]
}
```

- **Scope:** one global list; `project`/`tags` are filter dimensions (Decision 2). "show me the TODO" returns all; `?project=pi`/`?tag=dotfiles`/`?status=open` filter.
- IDs: `td-` + a short timestamp-base32 unique id (no dep — generate from `Date.now()` + random).
- Append-only history is **not** kept in v1 (status transitions overwrite `status`/`updatedAt`). A separate audit log is a non-goal.

## 5. Tool API (`todo`)

`pi.registerTool({ name: "todo", description: "Global cross-session TODO store. Use when the user says 'put in our TODO' / 'show me the TODO' / 'mark done'.", inputSchema, handler })`.

Single tool, `action`-driven (mirrors the rpiv/zero-pi-todo convention so it's familiar):

| action | params | returns |
|---|---|---|
| `list` | `status?`, `project?`, `tag?` | matching todos (id, text, priority, status, project, tags) |
| `add` | `text` (req), `project?`, `tags?`, `priority?`, `source?` | created todo |
| `update` | `id`, `text?`, `priority?`, `status?`, `project?`, `tags?` | updated todo |
| `complete` | `id` | sets `status: done`, `closedAt` |
| `delete` | `id` | sets `status: cancelled` (tombstone, not hard-delete) |
| `clear` | `status?` (default `done`) | cancels all of that status |

Notes:
- Tool handler **writes through to disk** on every mutation and updates the in-memory cache + re-renders the injected block.
- `list` with no filter returns **open + in_progress only** by default (the actionable set); pass `status: all` to see done/cancelled too.
- The model is instructed (in the tool description + injected block) to prefer this tool for TODO-style asks and to include a `source` hint when known.

## 6. Slash command (`/todo`)

`pi.registerCommand("todo", { … })` — human triage. Subcommands via args:

- `/todo` — print open + in_progress, grouped by project.
- `/todo all` — include done/cancelled.
- `/todo add <text>` — quick add (priority med, project from cwd-derived guess, tags []).
- `/todo done <id>` — mark done.
- `/todo rm <id>` — cancel/tombstone.
- `/todo clean` — cancel all `done` older than 30 days.

Output is a `ctx.ui.notify(...)` (or a message) — a compact, readable list, not an overlay (v1).

## 7. Decisions (flagged for RECTOR — baked-in recommendations)

1. **Store location** → `~/.pi/agent/todo.json` (agent-local; TODOs aren't secrets per the `~/Documents/secret/` convention). *Alt: `~/Documents/secret/todo.json` for iCloud sync.* **Recommend: `~/.pi/agent/todo.json`.**
2. **Scope** → one global list with `project`/`tags`/`priority` filter dimensions. **Recommend: global.**
3. **Auto-inject** → ON: append a capped "## Open TODOs (N)" block (titles + ids + priority, max 15, sorted priority→createdAt) to the system prompt on every `before_agent_start`. **Recommend: ON** (this is the whole point — closes the "next session is blind" gap).
4. **Name** → extension module `todo` (file `extensions/todo.ts`), tool `todo`, command `/todo`. Identity string for logs/notify: `armory-todo`. **Recommend as stated.**
5. **Seed import** → provide a **`/todo import`** command that scans the scattered existing TODOs (pi handoff "Next steps" #1–9 + each project `MEMORY.md`'s pending lines) and adds them as `status: open`, `source: "imported"`. **Not auto-run**; RECTOR invokes it once. **Recommend: provide, don't auto-run.**

## 8. Edge cases & failure modes

- **Concurrent sessions writing the same file** — two pi sessions mutating `todo.json` simultaneously could race. v1 mitigation: read-modify-write under a simple `flock`-style atomic write (write to `todo.json.tmp` + `rename`). Last-write-wins is acceptable for TODOs; an in-memory cache per session means a *different* session's write isn't seen until reload — the `before_agent_start` re-reads disk each prompt, so staleness is bounded to "one prompt behind". **Flag:** if RECTOR multi-rooms constantly, add `flock` (v1.1).
- **Corrupt / missing file** — on parse failure, back up to `todo.json.bad-<ts>` and start fresh with `{version:1,todos:[]}`; notify the user. Never crash the session.
- **Schema migration** — `version: 1`; on load, if `version` missing, best-effort migrate or reset.
- **Unbounded growth** — `done`/`cancelled` tombstones accumulate; `/todo clean` cancels-purges old ones. Injection block caps at 15 (overflow → "… +N more, use `todo list`").
- **Injection size** — keep the system-prompt block tiny (ids + ≤80-char titles). If >15 open, show top 15 by priority + a count.
- **No `ctx.ui` (non-interactive run, `pi -p`)** — guard all `ctx.ui.notify`/`confirm` behind `ctx.hasUI`; the tool + store still work headless.
- **Secrets leak** — TODO `text` is user-provided; it gets injected into the system prompt (sent to the LLM provider). Document this: **don't put secrets in TODOs**. (Matches the existing "don't put secrets in AGENTS.md/context" rule.)

## 9. Security / safety

- File perms `0600` on `todo.json` (it may contain project-internal references).
- Atomic write (tmp + rename). Never `JSON.stringify` partial.
- Validate tool input (text non-empty, priority enum, id exists for update/complete/delete → return a clear error otherwise).
- No network. No dependency on anything but `node:fs` + the pi extension API. (Mirrors `zero-pi-todo`'s "no dependencies" stance.)

## 10. Testing

- `tsx` unit tests for the store (add/update/complete/delete/clear, filtering, atomic write, corrupt-file recovery, schema migration).
- A `--self-test` path: the extension logs its loaded state on `session_start` (open count) so we can eyeball correctness in a real session.
- Manual gate: in a real pi session — `/todo add test`, restart pi, confirm the new session's system prompt contains the open TODO (verify via a throwaway `before_agent_start` log or by asking the agent "what are my open TODOs?").

## 11. Rollout / install

- Add `extensions/todo.ts` to `armory`; armory's `pi.extensions: ["./extensions"]` already loads all `.ts` there, so no `package.json` change needed.
- RECTOR installs locally: `pi install /Users/rector/local-dev/armory` (or the settings.json local-path entry already present for armory).
- Verify: `pi list` shows armory; `/todo` responds; a TODO added in session A is visible in a fresh session B.
- Commit to `getpipher/armory` (one commit: `feat(todo): global cross-session TODO extension`). GitLab mirror via existing `mirror-gitlab.yml`.

## 12. Open questions for RECTOR

- Confirm Decisions 1–5 (defaults above).
- Should the auto-inject block also list **due-today / critical-only** instead of all open? (v1: all open, capped 15.)
- Do you want a `/todo focus <id>` that sets one TODO as "in_progress" and pins just that one in the system prompt (less noise)? (v1.1 candidate.)

─────────────────────────────────────────────────────────────
End of SPEC. Awaiting your review + decision confirmations before I implement `extensions/todo.ts`.