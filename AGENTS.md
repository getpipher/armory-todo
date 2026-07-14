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
src/          # todo store (disk-backed JSON)
scripts/      # build/release helpers
test/         # todo-store tests
```

## Common Commands

```bash
node test/todo-store.test.mts   # run tests
```

## Notes

- Backed by `~/.pi/agent/todo.json` (global across all pi sessions).
- Never put secrets in a TODO — the text reaches the model provider.
- Open follow issue: project-scope management + self-awareness caps (anti-bloat) — see gh issue #1.