# v0.6.0 — Source-aware stale-active reaping ("safety protocol")

**Date:** 2026-07-29
**Status:** Design (awaiting RECTOR spec review)
**Branch:** `feat/reap-safety-protocol` off `main`
**Predecessor:** v0.5.3 (wiper fix + data-loss defense complete), PR #11, shipped 2026-07-21
**Target ship:** v0.6.0, auto-published via `release.yml` on `v0.6.0` tag

---

## 1. Problem

The v0.5.3 session closed armory-todo as "fully complete." Eight days of heavy
dogfooding later, RECTOR flagged a new symptom: **"every day I see many todos in
`/todo`."** Investigation of the live store (`~/.pi/agent/todo/todo.json`, 229
todos, 688KB) found three mechanics producing the bloat:

1. **`armory-fleet` auto-tracking (volume driver).** Every `subagent(...)` and
   background fleet run auto-creates a tracked TODO (`source: "armory-fleet"`,
   `tag: "fleet-run"`). 187 fleet todos created in 5 days — 82% of the live
   store. By design, but high-volume under dogfooding.

2. **Orphaned fleet runs (the real leak).** 42 fleet todos are
   `open`/`in_progress` with no `updatedAt` movement in 3–7 days. These are
   dead runs — background process killed, session closed, run abandoned —
   where fleet only closed its tracked todo on the **happy path** (foreground
   completion or `fleet_results` pull). Fleet never closes the todo when the
   run dies. **Auto-prune (v0.3.1) only touches `done`/`cancelled`, so orphaned
   active todos pile up indefinitely** — they never reach a terminal status.

3. **Done-todos linger up to 7 days (working as designed).** 151 done todos in
   the live store, all <3d old. Auto-prune archives them at the 7-day mark.
   Correct behavior, but high volume makes the visible queue large.

The user's hypothesis ("agents don't mark done") was **wrong** — the data shows
151 done vs 65 open; agents close todos fine. The real bug is **producer
discipline**: `armory-fleet` should close its todo on every terminal state, but
relying on every consumer to behave correctly is fragile. A new extension, a
sloppy agent, a crashed session — any can orphan a todo.

**The fix belongs in armory-todo, not fleet.** Defense-in-depth: the store
self-heals regardless of who wrote it. This is the "safety protocol" — any agent
or extension using armory-todo gets orphan-leak protection for free, without
coordinating with armory-todo's maintainers.

## 2. Goals

- **Self-heal orphaned active todos** from known-prolific producers
  (`armory-fleet`) without cross-package coordination.
- **Never auto-mutate real work.** Todos with no `source` (agent-managed,
  real-work) are flagged-only — irreversible state changes stay human-driven.
- **Reversibility.** Reaping is always to `cancelled` (never deleted) →
  `todo restore <id>` reverses it. Same `.bak-drop-<ts>` snapshot + audit-log
  guardrails as the v0.5.1 backup system — a bad threshold or runaway reap is
  recoverable.
- **Config-driven, YAGNI-respecting.** The reap-able source list lives in
  `todo.config.json`. Adding a new source later is a config edit, not a code
  change. Ship with `armory-fleet` only; expand when there's a real second
  producer.
- **Zero migration.** Pure additive — one new config section, one new module,
  two new health flags. Existing stores load unchanged.

## 3. Non-goals (deferred / rejected)

| Out of scope | Why |
|---|---|
| Auto-reap for non-fleet sources | Real work stays flag-only — irreversible actions stay human-driven |
| `reapTo: "done"` option | Only `cancelled` — semantically "abandoned run," not "completed work" |
| Per-project reap policy | `source` is the right discriminator (it identifies the producer), not `project` |
| Background reaper (cron) | `session_start` is enough — RECTOR boots pi daily |
| **Sub-todos** | Brainstormed and **rejected**. The diagnosed problem is orphan lifecycle, not hierarchy. Sub-todos add cascade semantics, break v0.5.0 caps counting, hit the pi-tui nested-UI blocker, and `notes`-as-checklist already covers 80% at zero schema cost. Revisit only if epic-level independent lifecycle tracking becomes a real pain. |
| Fixing `armory-fleet` itself | Filed as a separate observation — fleet should close its todo on run death. This spec makes armory-todo resilient *regardless* of whether fleet is ever fixed. |

## 4. Decisions log (from brainstorm Q&A)

| # | Question | Decision |
|---|---|---|
| Q1 | Drop sub-todos? | **Yes** — not needed once orphans self-heal. Rejected for this release; see §3. |
| Q2 | Safety posture (surface / source-aware reap / universal reap) | **B — source-aware auto-reap.** Fleet-source active todos are auto-`cancelled` at 2d; real (`source: undefined`) todos are flag-only at 14d. The `source` field cleanly separates producers (57 fleet = `armory-fleet`, ~22 real = no source). |
| Q3 | Fleet reap threshold | **2d.** The 42 current orphans are 3–7d old; 2d catches the next wave before they pile up. Fleet runs that matter resolve in minutes, not days. |
| Q4 | Non-fleet orphan-flag threshold | **14d.** RECTOR's dormant `zeroclaw-solana` sas-fix is 8d and intentionally paused — 14d gives it headroom so it doesn't nag. |
| Q5 | Reap-able source list | **`["armory-fleet"]` only, for now.** Open list is YAGNI; config schema supports future additions without code change. |
| Q6 | Reap target status | **`cancelled`** (reversible via `restore`); never deleted. |
| Q7 | "Stale" signal | **`updatedAt`** — already on every todo, bumped on every `update`. No new `lastTouchedAt` field. |
| Q8 | Reap timing | **`session_start`**, immediately after `autoPruneOnSessionStart()`. One self-healing pass per boot. |
| Q9 | Audit/backup | Reuse v0.5.1 `snapshotOnDrop` + `appendAudit` — same guardrails, no new mechanism. |

## 5. Architecture

| Layer | File | Change | New? |
|---|---|---|---|
| Config schema | `src/config.ts` | + `ReapConfig` interface + `DEFAULT_CONFIG.reap` + merge validation + corrupt recovery | extend |
| Reap logic | `src/reap.ts` | New module — `reapStaleActive(): ReapResult \| null` (mirrors `auto-prune.ts` shape) | **new** |
| Health flags | `src/health.ts` | + `ORPHAN` (flagged-not-reaped, real todos — advisory, transient) | extend |
| Audit/notify | `extensions/todo.ts` | `REAPED` is an **audit-log marker** (not a `HealthFlag` — reaped todos become `cancelled` and leave the active box, so health never sees them). Surfaced via the reap notify line + a `reapedCount` in the Done tab. | extend |
| Session_start wiring | `extensions/todo.ts` | Call `reapStaleActive()` after `autoPruneOnSessionStart()`; surface reap result in the existing notify block | extend |
| Backup/audit | `src/backup.ts` | Reuse `snapshotOnDrop` + `appendAudit` (box `"todo"`, counts-only) — no new mechanism | reuse |
| Store | `src/todo-store.ts` | `cancel(id)` already exists — reap calls it; no new store op | reuse |
| Panel | `src/panel-data.ts` / `panel.ts` | `ORPHAN` row indicator (⌛) + `reapedCount` in Done tab | extend |
| Tests | `test/todo-reap.test.mts` | **new suite** + extend `todo-config` + `todo-health` + `todo-auto-prune` | new + extend |

## 6. Config shape

```ts
interface ReapConfig {
  /** Non-fleet active todos older than this (by updatedAt) → ORPHAN flag, no mutation. */
  orphanFlagAfterDays: number;        // default 14
  /** Per-source reap policy. Sources not listed are flagged-only (never auto-mutated). */
  policy: Record<string, { reapAfterDays: number; reapTo: "cancelled" }>;
}

// DEFAULT_CONFIG.reap = {
//   orphanFlagAfterDays: 14,
//   policy: { "armory-fleet": { reapAfterDays: 2, reapTo: "cancelled" } }
// }
```

`TodoConfig` gains a `reap: ReapConfig` field. The existing merge + corrupt-recovery
path in `loadConfig` handles the new section with the same pattern: missing →
defaults merged in; corrupt → bad file backed up to `todo.config.json.bad-<ts>`,
defaults rewritten.

## 7. Data flow (one `session_start` pass)

| Step | Action | Mutates? | Audited? |
|---|---|---|---|
| 1 | `autoPruneOnSessionStart()` runs (existing) — moves done/cancelled >7d to archive | yes | yes (existing) |
| 2 | **`reapStaleActive()` runs** — for each active todo: compute `staleDays = (now − updatedAt) / 86400000` | no (read) | — |
| 3a | If `todo.source` ∈ `reap.policy` AND `staleDays ≥ reapAfterDays` → `cancel(id)`, count it | yes (→ `cancelled`) | **yes** — `.bak-drop-<ts>` snapshot + audit line `REAP src=<source> n=<K>` |
| 3b | Else if `staleDays ≥ orphanFlagAfterDays` → set transient `__orphanDays` (in-memory health pass, **not persisted**) → surfaces `ORPHAN` flag + panel ⌛ | no | flag only |
| 4 | If any reaped → notify `♻ Reaped N stale <source> runs (oldest Kd) — restore via /todo` | — | — |
| 5 | If any orphaned → existing "N open" notify appends `+ M orphaned (oldest Kd untouched)` | — | — |

**Key invariants:**
- A todo with `source: undefined` (real agent work) is **never** auto-mutated by
  the reap sweep. It can only get the `ORPHAN` flag, which is advisory.
- A todo with `source` not in `reap.policy` is also flag-only (same as no source).
- Reap target is always `cancelled` — `restore` reverses it. Nothing is ever deleted.
- The orphan flag is **transient** — recomputed each session from `updatedAt`. It
  is not written to disk (avoids a schema bump + migration just for a display hint).

## 8. Error handling & safety

| Risk | Guard |
|---|---|
| Cancelling real work by mistake | Only `source` ∈ `reap.policy` ever auto-mutates; real todos are flag-only forever |
| Reap is irreversible | `reapTo` is always `cancelled` (never deleted) → `todo restore <id>` reverses it |
| Bad threshold wipes a batch | `.bak-drop-<ts>` snapshot before the reap write (v0.5.1 pattern) + audit log line — same recovery path as the 2026-07-21 wipe incident |
| Reap runs on a corrupt store | `loadConfig` already backs up corrupt config to `.bad-<ts>`; reap skips if store load throws |
| Reap double-fires in one session | `session_start` is once-per-boot; idempotent anyway (already-cancelled todos aren't re-counted) |
| New source added later | Config-driven — add to `policy` map, no code change |
| Reap fires on a fresh store with no `reap` config | Merge installs defaults; `armory-fleet` policy present from first load |

## 9. Testing

| Suite | New/extend | Covers |
|---|---|---|
| `test/todo-reap.test.mts` | **new** | reap fleet at 2d ✓; flag non-fleet at 14d (no mutate) ✓; source-not-in-policy = flag-only ✓; `cancelled` reversibility ✓; audit line written ✓; `.bak-drop` created ✓; corrupt-config skip ✓; double-fire idempotent ✓; orphan flag is transient (not persisted) ✓; `updatedAt` is the stale signal ✓ |
| `test/todo-config.test.mts` | extend | `reap` defaults + merge + corrupt recovery |
| `test/todo-health.test.mts` | extend | `ORPHAN` flag raised (transient, not persisted); no regression on existing flags |
| `test/todo-reap.test.mts` | (also) | audit line carries `REAPED` marker; Done-tab `reapedCount` increments |
| `test/todo-auto-prune.test.mts` | extend | ordering: auto-prune then reap in the same `session_start` pass; both fire independently |

All new suites use the existing `TODO_DIR=tmp` isolation pattern (the
v0.5.3 wiper lesson — re-establish `process.env.TODO_DIR` at the start of any
appended section that writes).

## 10. Shipping

- Version bump: `0.5.3` → `0.6.0` (`package.json`).
- npm publish via CI on `v0.6.0` tag (`release.yml`).
- `~/.pi/agent/settings.json` pin updated to `npm:@getpipher/armory-todo@0.6.0`.
- GitHub Release v0.6.0 synced with npm.
- AGENTS.md structure table + Notes section updated (new `reap` module + suite).
- Memory: `~/.pi/agent/memory/-Users-rector-local-dev-getpipher-armory-todo/v0.6.0-shipped.md`.

## 11. Open questions for RECTOR (spec review)

1. **Notify copy** — accept the proposed strings (`♻ Reaped N…`, `+ M orphaned…`) or customize?
2. **Panel ⌛ glyph** for `ORPHAN` — or pick a different indicator (e.g. `⚠`)?
3. **First-run cleanup** — do you want a **one-shot reap** of the 42 existing
   orphans on first boot after v0.6.0 install (config-gated, one-time), or let
   the normal 2d threshold catch them naturally over the next session?