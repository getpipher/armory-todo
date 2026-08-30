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
              # reap (v0.6.0 source-aware stale-active live→archive safety protocol),
              # registry (projects.json: load/save/reconcile/setMaxOpen/rename), levenshtein (typo edit-distance),
              # projects (per-project scope overview), panel (interactive TUI + detail + Done + Projects tabs),
              # panel-data (panel formatters + audit summary), caps (v0.5.0 enforcement primitives: notes + project caps),
              # backup (v0.5.1 write-audit + rolling .bak + drop-snapshot + audit log),
              # triage (agent-validated prune engine: gather → execute → ledger filing, DI gh runner),
              # triage-prompt (versioned agent rubric — ships in-package, not improvised per session)
scripts/      # build/release helpers + triage E2E driver (tsx)
test/         # 16 suites: todo-store + todo-title-notes + todo-archive + todo-config + todo-migrate + todo-health
              # + todo-hard-prune + todo-auto-prune + registry + projects + panel-data + todo-caps + todo-backup
              # + todo-reap (v0.6.0) + triage (v0.7.0) + public-api
docs/         # todo-SPEC.md (v0.1.0, superseded) + superpowers/specs + superpowers/plans (v0.2.0→v0.6.0)
```

## Common Commands

```bash
node test/todo-store.test.mts        # live store tests (44)
node test/todo-title-notes.test.mts  # title+notes schema, cap, get, fallback (31)
node test/todo-archive.test.mts     # archive + prune + restore + v2→v3 migrate (55)
node test/todo-config.test.mts       # config defaults + corrupt recovery + health/reap config merge (35)
node test/todo-migrate.test.mts     # v1→v2 file move + v2→v3 schema (26)
node test/todo-health.test.mts      # bloat diagnostics + project/notes + transient ORPHAN flag (47)
node test/todo-hard-prune.test.mts   # confirm-gated deletion (16)
node test/todo-auto-prune.test.mts # session_start auto-prune → reap ordering + alert guard (18)
node test/registry.test.mts        # projects.json registry: load/save/reconcile/setMaxOpen/rename (34)
node test/projects.test.mts        # per-project scope overview (21)
node test/panel-data.test.mts       # panel helpers + ORPHAN/reap config + audit sum (51)
node test/todo-caps.test.mts        # v0.5.0 caps enforcement: notes + project + renderOpenBlock (68)
node test/todo-backup.test.mts     # v0.5.1 write-audit + rolling .bak + drop-snapshot (38)
node test/todo-reap.test.mts       # v0.6.0 source-aware immediate live→archive reap (11)
node test/triage.test.mts           # v0.7.0 triage: gather, D2 gate, safe class, ledger idempotency (26)
node test/public-api.test.mts      # stable public export contract (2)
# or run all: npm test (523/523 across 16 suites)
```

## Notes

- Backed by `~/.pi/agent/todo/` (folder layout since v0.2.0): `todo.json` (active + parked), `todo-archive.json` (done + cancelled — sealed history), `todo.config.json` (prune ages + health thresholds). Global across all pi sessions. A v1 single-file `~/.pi/agent/todo.json` is migrated automatically on first load.
- Lifecycle boxes (v0.2.0): active (open/in_progress, auto-injected) / parked (deferred, NOT injected) / archive (done/cancelled, NOT injected). `prune` moves done/cancelled to the archive (reversible via `restore`). Nothing is deleted by default.
- Title + notes (v0.3.0): the single `text` field split into `title` (≤120 chars, injected/listed) + `notes` (any length, not injected, read via `get`). Hard title cap at add/update. v2 `text`-only stores migrate to v3 on first load (curated for the 2 known todos + first-line fallback). Health gains a notes-bytes diagnostic.
- Auto-prune + unified Done (v0.3.1): done/cancelled older than `config.prune.defaultAgeDays` (7d) auto-archive on `session_start` (age-gated, never `--all`, silent when clean, rich notify). `listDoneUnified` merges live done + archived done (excludes `cancelled`); surfaced via `todo list status:'done'`, `/todo finished` slash, and a new `Done` box tab in the `/todo` panel (location-tagged rows, View detail + Restore-from-archive). Injection contract UNCHANGED (only open+in_progress injected).
- Project-scope management (v0.4.0): project registry (`projects.json`, lazy-synced on read) + `projects` overview + per-project `health` flags (`PROJECT_OVER`/`TYPO`/`LARGE`/`STALE`) + advisory `maxOpen` slot + panel 6th `Projects` tab (Rename/Set maxOpen/Filter) + `todo project_rename` (rename or merge). Advisory only.
- Caps enforcement (v0.5.0): per-project `maxOpen` blocks `add` + project-move (open/in_progress only; un-park intentionally not blocked). `health.maxNotesBytes` (default 8KB) rejects oversize notes at write (grandfathered existing; `NOTES_OVER` flag + `NotesBytes.maxId` suggestion). `renderOpenBlock` cap-aware: over `activeMaxOpen` → lean summary (counts + `PROJECT_OVER` projects + pointer), under → row list. Zero migration. Issue #1 Feature B (the forcing-function half) shipped.
- Write-audit + backup (v0.5.1): every `saveStore`/`saveArchive` backs up to `<path>.bak` (rolling) + snapshots pre-write state to `<path>.bak-drop-<ts>` on a count drop + appends a counts-only line to `todo-audit.log`. Post the v0.2.0 migration data-loss incident (47-todo store destroyed, no backup). Recovery: restore from the newest `todo.json.bak-drop-<ts>`.
- Source-aware stale-active reaping (v0.6.0): `session_start` auto-archives stale active todos from configured producer sources as `cancelled` (default `armory-fleet` after 2d), so `restore` works immediately. Non-policy active todos untouched >=14d get a transient advisory `ORPHAN` flag and ⌛ panel marker — never auto-mutated. Interactive Config exposes both thresholds. Expected live→archive drops retain backup/snapshot/audit but suppress false wipe alerts. This is the store-level safety protocol: every agent/extension gets orphan-leak protection regardless of producer discipline.
- Agent-validated triage (v0.7.0): `todo(action:'triage')` gathers candidates (stale `health.activeStaleDays` + orphans `reap.orphanFlagAfterDays` + over-cap projects + agent-source; open-only, policy sources left to reap) and returns them with the versioned rubric (`src/triage-prompt.ts`, `triage-rubric/v1`) — nothing mutates. The agent validates with read-only probes and proposes; execution requires the batch `approve:[…]` call. `autoSafe`/`--yes` executes ONLY mechanical debris (prompt-shaped title + agent context). Closed items sweep to the archive (reversible) and file as CLOSED issues in `getpipher/todo-ledger` (private; client-side title match for idempotency — search index lags; create-then-PATCH closed — create API ignores `state`; labels `todo-archive`/`project/<name>`/`verdict/cancel`; gh failure archives locally + reports the skip, never blocks; `TODO_TRIAGE_SKIP_FILING=1` + `TODO_LEDGER_REPO` env overrides).
- Panel Triage tab (v0.8.0): 7th box; rows pre-chipped (safe debris → close, rest keep), per-row verdict override with inline survivor/evidence inputs, `A`×2 batch gate (arm → execute), esc disarms, re-gather on entry/after execution. `scripts/triage-panel-e2e.mts` drives the real panel headlessly.
- Never put secrets in a TODO — the text reaches the model provider.
- Known deferred issue: no in-panel multi-line `notes` editing (pi-tui nested-UI blocker); `notes` is model-managed via the `todo` tool.
- Issue #1 fully shipped (v0.4.0 Feature A + v0.5.0 Feature B). Open data fix: RECTOR's `foo-bat` typo (1 done) — `todo project_rename foo-bat foo-bar` to clean (RECTOR's call).