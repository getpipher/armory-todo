<!-- Satellite context file — extends the global hub (~/.claude/CLAUDE.md | ~/.pi/agent/AGENTS.md). Host-neutral; project-specific only. Do not duplicate hub standards here. -->

# armory-todo

> Global, cross-session TODO for Pi — a single disk file that *every* session reads, plus an auto-injected `## Open TODOs` block in the system prompt. Zero dependencies. npm: `@getpipher/armory-todo`.

**Org context:** getpipher is the Pi coding-agent ecosystem. No GitLab mirror for getpipher.

## What it solves

pi sessions are ephemeral conversation branches. A TODO in session A is invisible to session B. Existing pi todo extensions are conversation-branch-scoped (persist via `appendEntry()`, survive compaction + `/reload` *within* one session) — none bridge across separate sessions.

`armory-todo` is the other shape: one disk file every session reads, auto-injected into the system prompt so a fresh session starts already aware of pending work.

| | survives compaction/reload within a session | survives across separate sessions | auto-surfaced in every new session |
|---|:---:|:---:|:---:|
| branch-scoped todo extensions | ✅ | ❌ | ❌ |
| **armory-todo** | ✅ | ✅ | ✅ |

## Install

```bash
pi install git:github.com/getpipher/armory-todo   # from git
pi install npm:@getpipher/armory-todo            # from npm (scoped)
```

## Structure

```
extensions/   # pi extension — todo tool (model-callable, incl. get) + /todo slash command + auto-inject
src/          # todo-store (live CRUD + title/notes + getTodo + list), archive (prune + restore + v3 migrate),
              # config (prune/health thresholds + perProjectDefaultMax), migrate (v1→v2 file move + v2→v3 schema),
              # paths (TODO_DIR resolution + getRegistryPath), health (bloat diagnostics + notes-bytes + per-project flags),
              # hard-prune (confirm-gated deletion), auto-prune (session_start age-gated prune),
              # registry (projects.json: load/save/reconcile/setMaxOpen/rename), levenshtein (typo edit-distance),
              # projects (per-project scope overview), panel (interactive TUI + detail + Done + Projects tabs),
              # panel-data (pure helpers for panel)
scripts/      # build/release helpers
test/         # 11 suites: todo-store + todo-title-notes + todo-archive + todo-config + todo-migrate + todo-health
              # + todo-hard-prune + todo-auto-prune + registry + projects + panel-data
docs/         # todo-SPEC.md (v0.1.0, superseded) + superpowers/specs + superpowers/plans (v0.2.0 + v0.3.0 + v0.3.1 + v0.4.0)
```

## Common Commands

```bash
node test/todo-store.test.mts        # live store tests (44)
node test/todo-title-notes.test.mts  # title+notes schema, cap, get, fallback (31)
node test/todo-archive.test.mts     # archive + prune + restore + v2→v3 migrate (55)
node test/todo-config.test.mts       # config defaults + corrupt recovery + perProjectDefaultMax merge (17)
node test/todo-migrate.test.mts     # v1→v2 file move + v2→v3 schema (26)
node test/todo-health.test.mts      # bloat diagnostics + notes-bytes + per-project flags (34)
node test/todo-hard-prune.test.mts   # confirm-gated deletion (16)
node test/todo-auto-prune.test.mts # session_start age-gated auto-prune (12)
node test/registry.test.mts        # projects.json registry: load/save/reconcile/setMaxOpen/rename (28)
node test/projects.test.mts        # per-project scope overview (21)
node test/panel-data.test.mts       # TUI panel pure helpers (41)
# or run all: npm test (325/325 across 11 suites)
```

## Notes

- Backed by `~/.pi/agent/todo/` (folder layout since v0.2.0): `todo.json` (active + parked), `todo-archive.json` (done + cancelled — sealed history), `todo.config.json` (prune ages + health thresholds). Global across all pi sessions. A v1 single-file `~/.pi/agent/todo.json` is migrated automatically on first load.
- Lifecycle boxes (v0.2.0): active (open/in_progress, auto-injected) / parked (deferred, NOT injected) / archive (done/cancelled, NOT injected). `prune` moves done/cancelled to the archive (reversible via `restore`). Nothing is deleted by default.
- Title + notes (v0.3.0): the single `text` field split into `title` (≤120 chars, injected/listed) + `notes` (any length, not injected, read via `get`). Hard title cap at add/update. v2 `text`-only stores migrate to v3 on first load (curated for the 2 known todos + first-line fallback). Health gains a notes-bytes diagnostic.
- Auto-prune + unified Done (v0.3.1): done/cancelled older than `config.prune.defaultAgeDays` (7d) auto-archive on `session_start` (age-gated, never `--all`, silent when clean, rich notify). `listDoneUnified` merges live done + archived done (excludes `cancelled`); surfaced via `todo list status:'done'`, `/todo finished` slash, and a new `Done` box tab in the `/todo` panel (location-tagged rows, View detail + Restore-from-archive). Injection contract UNCHANGED (only open+in_progress injected).
- Never put secrets in a TODO — the text reaches the model provider.
- Known deferred issue: no in-panel multi-line `notes` editing (pi-tui nested-UI blocker); `notes` is model-managed via the `todo` tool.
- Open follow issue: project-scope management + self-awareness caps (anti-bloat) — see gh issue #1. Workstream C (preventive caps-on-add + project registry) remains; Workstreams A + B + the v0.3.1 auto-prune/Done-view shipped (v0.2.0 + v0.3.0 + v0.3.1).