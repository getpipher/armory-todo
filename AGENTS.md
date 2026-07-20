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
extensions/   # pi extension — todo tool (model-callable) + /todo slash command + auto-inject
src/          # todo-store (live CRUD + parked + list), archive (prune + restore + summary),
              # config (prune/health thresholds), migrate (v1→v2), paths (TODO_DIR resolution)
scripts/      # build/release helpers
test/         # todo-store + todo-archive + todo-config + todo-migrate + todo-health + todo-hard-prune tests
docs/         # todo-SPEC.md (v0.1.0) + superpowers/specs + superpowers/plans (v0.2.0)
```

## Common Commands

```bash
node test/todo-store.test.mts     # live store tests (42)
node test/todo-archive.test.mts   # archive + prune + restore + list (32)
node test/todo-config.test.mts    # config defaults + corrupt recovery (15)
node test/todo-migrate.test.mts   # v1→v2 migration (6)
# or run all: for t in todo-store todo-archive todo-config todo-migrate; do node test/$t.test.mts; done
```

## Notes

- Backed by `~/.pi/agent/todo/` (folder layout since v0.2.0): `todo.json` (active + parked), `todo-archive.json` (done + cancelled — sealed history), `todo.config.json` (prune ages + health thresholds). Global across all pi sessions. A v1 single-file `~/.pi/agent/todo.json` is migrated automatically on first load.
- Lifecycle boxes (v0.2.0): active (open/in_progress, auto-injected) / parked (deferred, NOT injected) / archive (done/cancelled, NOT injected). `prune` moves done/cancelled to the archive (reversible via `restore`). Nothing is deleted by default.
- Never put secrets in a TODO — the text reaches the model provider.
- Open follow issue: project-scope management + self-awareness caps (anti-bloat) — see gh issue #1. SPEC-2 (health + hard-prune) + SPEC-3 (interactive /todo TUI panel) + Workstream B (title/notes split) + Workstream C (preventive caps) remain.