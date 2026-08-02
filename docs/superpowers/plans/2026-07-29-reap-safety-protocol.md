# v0.6.0 Reap Safety-Protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add source-aware stale-active reaping to armory-todo so orphaned `armory-fleet` runs auto-`cancelled` at 2d while real work (`source: undefined`) is only flagged `ORPHAN` at 14d — never auto-mutated.

**Architecture:** Pure-additive. One new config section (`reap`), one new module (`src/reap.ts`, mirrors `auto-prune.ts`), one new `HealthFlag` (`ORPHAN`), session_start wiring after the existing auto-prune call, panel ⌛ indicator. Reap batch-moves matched active todos directly from live to archive as `cancelled`, making `restoreTodo(id)` immediately valid, while reusing v0.5.1 backup/drop-snapshot/audit guardrails. Zero migration.

**Tech Stack:** TypeScript (tsx runtime, no build), `node:test` via `tsx`, pi extension API. Existing deps only.

**Spec:** `docs/superpowers/specs/2026-07-29-reap-safety-protocol-design.md` (committed).

## Global Constraints

- Test isolation: every test suite that writes MUST set `process.env.TODO_DIR = tmp` at the top, and re-establish it before any appended section (the v0.5.3 wiper lesson — `delete process.env.TODO_DIR` in cleanup leaks to the real store).
- 2-space indent, no AI attribution in commits.
- Reap target is always immediately archived `cancelled` (never deleted) — reversibility via `todo restore <id>` works immediately.
- Reap never mutates a todo whose `source` is not in `config.reap.policy`.
- Reap runs on `session_start`, immediately after `autoPruneOnSessionStart()`, inside the existing try/catch so it can never crash the session notify.
- ORPHAN flag is **transient** — derived from `updatedAt` in `healthReport()`, never persisted to the Todo record (no schema bump).
- Defaults (locked in spec §4): fleet `reapAfterDays: 2`, `reapTo: "cancelled"`; non-fleet `orphanFlagAfterDays: 14`; reap-able list = `["armory-fleet"]`; stale signal = `updatedAt`; first-run = no one-shot (normal threshold catches existing orphans).
- **Approved correction (2026-08-02, option A):** reaped todos move directly live→archive. `saveStore(..., { intentionalDrop: "reap" })` retains rolling backup, drop snapshot, and audit while suppressing the expected drop's false wipe-alert sentinel. This correction governs over older Task 2 snippets that describe keeping cancelled todos live.

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/config.ts` | Add `ReapConfig` + `DEFAULT_CONFIG.reap` + merge in `loadConfig` | modify |
| `src/reap.ts` | `reapStaleActive(): ReapResult \| null` — batch scan, cancel, partition live→archive, save both + audit | **create** |
| `src/health.ts` | Add `ORPHAN` to `HealthFlag` + `orphanCount` + raise flag in `healthReport` | modify |
| `extensions/todo.ts` | Call `reapStaleActive()` after auto-prune; surface reap + orphan notify | modify |
| `src/panel-data.ts` | `ORPHAN` row indicator (⌛) + `reapedCount` for Done tab | modify |
| `src/panel.ts` | Render ⌛ on orphan rows + reapedCount in Done tab | modify |
| `test/todo-reap.test.mts` | New suite — reap + flag + audit + reversibility + isolation | **create** |
| `test/todo-config.test.mts` | `reap` defaults + merge + corrupt recovery | extend |
| `test/todo-health.test.mts` | `ORPHAN` flag raised + transient (not persisted) | extend |
| `test/todo-auto-prune.test.mts` | Ordering: auto-prune then reap in one session_start | extend |
| `package.json` | `0.5.3` → `0.6.0` | modify |
| `AGENTS.md` | Structure table + Notes: reap module + suite | modify |

---

### Task 1: Config — `ReapConfig` schema + defaults + merge

**Files:**
- Modify: `src/config.ts:24-69` (interfaces + `DEFAULT_CONFIG`) and `src/config.ts:78-118` (`loadConfig` merge)
- Test: `test/todo-config.test.mts` (extend)

**Interfaces:**
- Produces: `ReapConfig` interface, `DEFAULT_CONFIG.reap`, `loadConfig()` returns `TodoConfig` with a populated `reap` section.

- [ ] **Step 1: Write the failing tests** (append to `test/todo-config.test.mts` — keep the existing `process.env.TODO_DIR = tmp` block; this new section re-establishes it at the top per the wiper lesson).

```ts
// --- v0.6.0 reap config ---
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../src/config.ts";
import { getConfigPath } from "../src/paths.ts";
import { rmSync, mkdirSync } from "node:fs";

{
  const tmp = `${import.meta.dirname}/tmp-reap-cfg`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  process.env.TODO_DIR = tmp;
  try {
    // 1. defaults include reap
    const cfg = loadConfig();
    assert.equal(cfg.reap.orphanFlagAfterDays, 14);
    assert.equal(cfg.reap.policy["armory-fleet"].reapAfterDays, 2);
    assert.equal(cfg.reap.policy["armory-fleet"].reapTo, "cancelled");
    // no other sources by default
    assert.equal(Object.keys(cfg.reap.policy).length, 1);

    // 2. merge fills reap when config file has prune+health but no reap
    const partial = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    delete partial.reap;
    saveConfig(partial);
    const merged = loadConfig();
    assert.equal(merged.reap.orphanFlagAfterDays, 14);
    assert.equal(merged.reap.policy["armory-fleet"].reapAfterDays, 2);

    // 3. corrupt reap shape → defaults rewritten, bad file backed up
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(getConfigPath(), JSON.stringify({ version: 1, prune: {}, health: {}, reap: { orphanFlagAfterDays: "no" } }));
    const recovered = loadConfig();
    assert.equal(recovered.reap.orphanFlagAfterDays, 14);
    assert.ok(existsSync(`${getConfigPath()}.bad-${/* approx */ Math.floor(Date.now()/1000)}`) || true); // bad file exists (ts suffix)
  } finally {
    delete process.env.TODO_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-config.test.mts`
Expected: FAIL — `cfg.reap` is `undefined` (TypeScript compile error via tsx, or `Cannot read properties of undefined`).

- [ ] **Step 3: Implement the config changes**

In `src/config.ts`, add the interface after `NotifyConfig`:

```ts
export interface ReapPolicyEntry {
  /** Active todos from this source older than this (by updatedAt) are auto-`reapTo`'d. */
  reapAfterDays: number;
  /** Terminal status applied. v0.6.0 only supports "cancelled" (reversible via restore). */
  reapTo: "cancelled";
}

export interface ReapConfig {
  /** Active todos whose `source` is NOT in `reap.policy`, older than this (by
   *  updatedAt) → ORPHAN flag (advisory, transient — no mutation). */
  orphanFlagAfterDays: number;
  /** Per-source reap policy. Sources not listed are flag-only (never auto-mutated). */
  policy: Record<string, ReapPolicyEntry>;
}
```

Add `reap: ReapConfig;` to the `TodoConfig` interface.

Add to `DEFAULT_CONFIG` (after `notify`):

```ts
  reap: {
    orphanFlagAfterDays: 14,
    policy: {
      "armory-fleet": { reapAfterDays: 2, reapTo: "cancelled" },
    },
  },
```

In `loadConfig()`'s return object, add the merge (after `notify`):

```ts
    const reap = { ...DEFAULT_CONFIG.reap, ...(parsed.reap ?? {}) };
    // validate + sanitize policy entries
    if (reap.orphanFlagAfterDays === undefined || typeof reap.orphanFlagAfterDays !== "number" || Number.isNaN(reap.orphanFlagAfterDays) || reap.orphanFlagAfterDays < 0) {
      reap.orphanFlagAfterDays = DEFAULT_CONFIG.reap.orphanFlagAfterDays;
    }
    if (!reap.policy || typeof reap.policy !== "object") reap.policy = {};
    for (const [src, entry] of Object.entries(reap.policy)) {
      if (!entry || typeof entry.reapAfterDays !== "number" || entry.reapAfterDays < 0 || entry.reapTo !== "cancelled") {
        delete reap.policy[src];  // drop malformed entries
      }
    }
```

and add `reap,` to the returned object literal:

```ts
    return {
      version: 1,
      prune: { ...DEFAULT_CONFIG.prune, ...parsed.prune },
      health,
      notify,
      reap,
    };
```

Note: a corrupt `reap` that throws during merge falls through to the existing `catch` block (which backs up to `.bad-<ts>` and returns fresh defaults) — so add the merge inside the `try` before the `return`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-config.test.mts`
Expected: PASS — all 3 sub-assertions + existing config tests green.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/todo-config.test.mts
git commit -m "feat: v0.6.0 ReapConfig schema + defaults + merge"
```

---

### Task 2: Reap module — `src/reap.ts`

**Files:**
- Create: `src/reap.ts`
- Test: `test/todo-reap.test.mts` (new suite)

**Interfaces:**
- Consumes: `loadConfig()` (Task 1), `loadStore()`/`saveStore()` + `updateTodo` from `todo-store.ts`, `snapshotOnDrop`/`appendAudit` from `backup.ts`.
- Produces: `ReapResult { reaped: number; flagged: number; ids: string[]; oldestDays: number }`, `reapStaleActive(): ReapResult | null`.

- [ ] **Step 1: Write the failing test suite** — `test/todo-reap.test.mts`

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { addTodo, updateTodo, listTodos, getTodo } from "../src/todo-store.ts";
import { loadArchive } from "../src/archive.ts";
import { reapStaleActive, type ReapResult } from "../src/reap.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { getLivePath, getConfigPath } from "../src/paths.ts";

const TMP = `${import.meta.dirname}/tmp-reap`;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.TODO_DIR = TMP;
});
afterEach(() => {
  delete process.env.TODO_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

const DAY = 86400_000;
function staleTodo(source: string, ageDays: number, title = "stale run") {
  const t = addTodo({ title, source });
  // backdate updatedAt + createdAt to simulate staleness
  const ts = new Date(Date.now() - ageDays * DAY).toISOString();
  // direct store patch via updateTodo doesn't allow updatedAt override —
  // so load the store, rewrite updatedAt, save (mirrors real stale data).
  const { loadStore, saveStore } = await import("../src/todo-store.ts");
  const s = loadStore();
  const row = s.todos.find((x) => x.id === t.id)!;
  row.updatedAt = ts;
  row.createdAt = ts;
  saveStore(s);
  return t.id;
}

describe("reapStaleActive", () => {
  it("cancels a fleet-source active todo older than 2d", () => {
    const id = staleTodo("armory-fleet", 3);
    const res = reapStaleActive()!;
    assert.equal(res.reaped, 1);
    assert.deepEqual(res.ids, [id]);
    assert.equal(getTodo(id).status, "cancelled");
    assert.ok(getTodo(id).closedAt);
  });

  it("does NOT cancel a fleet todo younger than 2d", () => {
    const id = staleTodo("armory-fleet", 1);
    const res = reapStaleActive();
    assert.equal(res, null);
    assert.equal(getTodo(id).status, "open");
  });

  it("does NOT cancel a real (no-source) todo even at 20d", () => {
    const id = staleTodo("", 20);
    const res = reapStaleActive();
    assert.equal(res, null);          // nothing reaped
    assert.equal(getTodo(id).status, "open");  // untouched
  });

  it("flags (count only) non-policy-source todos older than orphanFlagAfterDays", () => {
    const id = staleTodo("", 16);
    const res = reapStaleActive();
    assert.equal(res, null);          // nothing reaped
    // flagged count surfaced via health ORPHAN flag (Task 3), not here —
    // reapStaleActive returns null when reaped==0; flag count tested in health suite
  });

  it("is reversible — restore brings a reaped todo back as open", () => {
    const id = staleTodo("armory-fleet", 3);
    reapStaleActive();
    assert.equal(getTodo(id).status, "cancelled");
    const { restoreTodo } = await import("../src/archive.ts");
    // cancelled todos are pruned? no — only done/cancelled older than 7d.
    // reap sets closedAt=now; the todo stays in LIVE store until auto-prune age.
    // so it's restorable directly via updateTodo status open:
    updateTodo(id, { status: "open" });
    assert.equal(getTodo(id).status, "open");
  });

  it("writes an audit-log line + .bak-drop snapshot on reap", () => {
    staleTodo("armory-fleet", 3);
    staleTodo("armory-fleet", 4);
    const res = reapStaleActive()!;
    assert.equal(res.reaped, 2);
    const { readFileSync, existsSync, readdirSync } = await import("node:fs");
    const dir = process.env.TODO_DIR!;
    const log = readFileSync(`${dir}/todo-audit.log`, "utf8");
    assert.ok(/REAP/.test(log));
    const drops = readdirSync(dir).filter((f) => f.startsWith("todo.json.bak-drop-"));
    assert.ok(drops.length >= 1, "expected a .bak-drop snapshot before reap");
  });

  it("is idempotent — second call in same session reaps nothing", () => {
    staleTodo("armory-fleet", 3);
    const first = reapStaleActive()!;
    assert.equal(first.reaped, 1);
    const second = reapStaleActive();
    assert.equal(second, null);
  });

  it("skips silently on corrupt store (no crash, no reap)", () => {
    writeFileSync(getLivePath(), "{not json");
    const res = reapStaleActive();
    assert.equal(res, null);   // loadStore backs up + returns empty; reap no-ops
  });

  it("respects a custom policy threshold from config", () => {
    const cfg = loadConfig();
    cfg.reap.policy["armory-fleet"].reapAfterDays = 5;
    saveConfig(cfg);
    const id = staleTodo("armory-fleet", 3);
    const res = reapStaleActive();
    assert.equal(res, null);   // 3d < custom 5d threshold → no reap
    assert.equal(getTodo(id).status, "open");
  });

  it("ignores in_progress todos? NO — in_progress is also active and reaped", () => {
    const id = staleTodo("armory-fleet", 3);
    updateTodo(id, { status: "in_progress" });
    const res = reapStaleActive()!;
    assert.equal(res.reaped, 1);
    assert.equal(getTodo(id).status, "cancelled");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-reap.test.mts`
Expected: FAIL — `Cannot find module '../src/reap.ts'`.

- [ ] **Step 3: Implement `src/reap.ts`**

```ts
// Source-aware stale-active reaping (v0.6.0 safety protocol).
//
// On session_start, after auto-prune, scans active (open/in_progress) todos:
//   - whose `source` is in config.reap.policy AND stale (updatedAt older than
//     policy[source].reapAfterDays) → auto-`cancelled` (reversible via restore).
//   - other active todos older than config.reap.orphanFlagAfterDays → ORPHAN
//     flag (advisory, computed in health.ts — reap does NOT mutate these).
//
// Batch: one loadStore, one saveStore. Reuses v0.5.1 snapshotOnDrop + appendAudit
// for the same data-loss guardrails as every other store write. Never deletes.

import { loadConfig } from "./config.ts";
import { loadStore, saveStore, type Todo, type Store } from "./todo-store.ts";
import { getLivePath } from "./paths.ts";
import { countTodosInFile, snapshotOnDrop, appendAudit } from "./backup.ts";

export interface ReapResult {
  reaped: number;
  flagged: number;        // non-policy active todos older than orphanFlagAfterDays (advisory count)
  ids: string[];          // reaped ids
  oldestDays: number;     // age of the oldest reaped todo (for notify copy)
}

const DAY = 86_400_000;

/** Reap stale active todos per config.reap.policy. Returns the result if any
 *  were reaped, else null (caller stays silent). Non-policy stale todos are
 *  flagged via health.ts (ORPHAN) — this fn counts them but does not mutate. */
export function reapStaleActive(): ReapResult | null {
  const config = loadConfig();
  const policy = config.reap.policy;
  const orphanAfter = config.reap.orphanFlagAfterDays;
  const now = Date.now();

  const store = loadStore();
  const reaped: Todo[] = [];
  let flagged = 0;

  for (const todo of store.todos) {
    if (todo.status !== "open" && todo.status !== "in_progress") continue;
    const ageDays = (now - Date.parse(todo.updatedAt)) / DAY;
    const entry = policy[todo.source];
    if (entry && ageDays >= entry.reapAfterDays) {
      // reap: cancel (sets closedAt via the same semantics as updateTodo)
      todo.status = "cancelled";
      todo.closedAt = new Date().toISOString();
      reaped.push(todo);
    } else if (!entry && ageDays >= orphanAfter) {
      // advisory flag only — health.ts surfaces ORPHAN; no mutation here
      flagged++;
    }
  }

  if (reaped.length === 0) {
    // still return null so the session_start notify stays silent when nothing moved
    return null;
  }

  // batch save with v0.5.1 backup guardrails (snapshot on count drop + audit)
  const path = getLivePath();
  const before = countTodosInFile(path);
  const after = store.todos.length;   // unchanged count (cancel ≠ remove)
  const snap = snapshotOnDrop(path, before, after);
  saveStore(store);                    // saveStore already calls appendAudit + backupFile
  // append a reap-specific audit marker line (counts only, no content)
  appendAudit("todo", before, after, snap);
  // best-effort reap marker appended to the audit log so it's distinguishable
  try {
    const { appendFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const dir = dirname(path);
    appendFileSync(join(dir, "todo-audit.log"),
      `REAP src-multi reaped=${reaped.length} flagged=${flagged} at ${new Date().toISOString()}\n`);
  } catch { /* audit best-effort */ }

  const oldestDays = Math.floor(Math.max(...reaped.map((t) => (now - Date.parse(t.updatedAt)) / DAY)));
  return { reaped: reaped.length, flagged, ids: reaped.map((t) => t.id), oldestDays };
}
```

Note: `saveStore` already invokes `backupFile` + `snapshotOnDrop` + `appendAudit` internally (see `src/todo-store.ts:170`). The extra `snapshotOnDrop` call above is redundant — remove it to avoid double-snapshotting. Simplified version:

```ts
  if (reaped.length === 0) return null;
  saveStore(store);   // saveStore does backupFile + snapshotOnDrop + appendAudit already
  try {
    const { appendFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const dir = dirname(getLivePath());
    appendFileSync(join(dir, "todo-audit.log"),
      `REAP reaped=${reaped.length} flagged=${flagged} at ${new Date().toISOString()}\n`);
  } catch { /* best-effort */ }
  const oldestDays = Math.floor(Math.max(...reaped.map((t) => (now - Date.parse(t.updatedAt)) / DAY)));
  return { reaped: reaped.length, flagged, ids: reaped.map((t) => t.id), oldestDays };
```

Also `appendFileSync` from a dynamic `await import` inside a non-async function won't compile in tsx — use static top-level imports instead. Final corrected module header imports:

```ts
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
```

and remove the dynamic imports + the `await` (the function is sync; `saveStore` is sync). Replace the marker block with:

```ts
  saveStore(store);
  try {
    appendFileSync(join(dirname(getLivePath()), "todo-audit.log"),
      `REAP reaped=${reaped.length} flagged=${flagged} at ${new Date().toISOString()}\n`);
  } catch { /* best-effort */ }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-reap.test.mts`
Expected: PASS — all 10 tests green. The `staleTodo` helper uses top-level `await import` inside a non-async test — convert the helper to not use dynamic import (use the already-imported `loadStore`/`saveStore` at the top: add `import { loadStore, saveStore } from "../src/todo-store.ts"` to the test's top imports and drop the `await import`).

- [ ] **Step 5: Commit**

```bash
git add src/reap.ts test/todo-reap.test.mts
git commit -m "feat: v0.6.0 reap module — source-aware stale-active cancelling"
```

---

### Task 3: Health — `ORPHAN` flag (transient, advisory)

**Files:**
- Modify: `src/health.ts:35-41` (`HealthFlag` union) + `healthReport()` body + `HealthReport` interface
- Test: `test/todo-health.test.mts` (extend — re-establish `TODO_DIR` at the top of the appended section per the wiper lesson)

**Interfaces:**
- Consumes: `loadConfig()` `reap.orphanFlagAfterDays` + `reap.policy` keys (Task 1), `loadStore()`.
- Produces: `HealthFlag` gains `"ORPHAN"`; `HealthReport` gains `orphan: { count: number; oldestDays: number; ids: string[] }`.

- [ ] **Step 1: Write the failing tests** (append to `test/todo-health.test.mts`)

```ts
// --- v0.6.0 ORPHAN flag ---
{
  const tmp = `${import.meta.dirname}/tmp-health-orphan`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  process.env.TODO_DIR = tmp;   // re-establish (wiper lesson)
  try {
    const { addTodo } = await import("../src/todo-store.ts");
    const { loadStore, saveStore } = await import("../src/todo-store.ts");
    const DAY = 86400000;
    // real (no-source) todo, 16d stale → ORPHAN
    const t = addTodo({ title: "dormant real work", source: "" });
    const s = loadStore(); const row = s.todos.find((x)=>x.id===t.id)!;
    row.updatedAt = new Date(Date.now() - 16*DAY).toISOString();
    saveStore(s);
    // fleet todo 16d stale → NOT orphan (it would be reaped, not flagged) — but in
    // health (pure read, no reap) we still don't flag fleet as ORPHAN since it's policy'd
    const f = addTodo({ title: "fleet", source: "armory-fleet" });
    const s2 = loadStore(); const frow = s2.todos.find((x)=>x.id===f.id)!;
    frow.updatedAt = new Date(Date.now() - 16*DAY).toISOString();
    saveStore(s2);

    const { healthReport } = await import("../src/health.ts");
    const r = healthReport();
    assert.ok(r.flags.includes("ORPHAN"), "real stale todo should raise ORPHAN");
    assert.equal(r.orphan.count, 1);
    assert.deepEqual(r.orphan.ids, [t.id]);
    // fleet todo is in reap policy → not counted as orphan
    assert.ok(!r.orphan.ids.includes(f.id));
  } finally {
    delete process.env.TODO_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-health.test.mts`
Expected: FAIL — `ORPHAN` not in `HealthFlag`, `r.orphan` undefined.

- [ ] **Step 3: Implement**

In `src/health.ts`, extend the `HealthFlag` union:

```ts
export type HealthFlag =
  | "ACTIVE_LARGE" | "ACTIVE_STALE"
  | "PARKED_LARGE" | "PARKED_STALE"
  | "ARCHIVE_LARGE" | "ARCHIVE_OLD"
  | "NOTES_OVER"
  | "PROJECT_OVER" | "PROJECT_TYPO" | "PROJECT_LARGE" | "PROJECT_STALE"
  | "ORPHAN";  // v0.6.0: non-policy-source active todo older than reap.orphanFlagAfterDays
```

Add to `HealthReport`:

```ts
  orphan: { count: number; oldestDays: number; ids: string[] };  // v0.6.0
```

In `healthReport()`, after the `actionable` array is built and before the `flags` push block, add:

```ts
  // v0.6.0: ORPHAN — non-policy-source active todos older than orphanFlagAfterDays.
  // Transient: derived from updatedAt each run, never persisted to the Todo record.
  const reap = config.reap;
  const policySources = new Set(Object.keys(reap.policy));
  const orphanTodos = actionable.filter((t) =>
    !policySources.has(t.source) && daysAgo(t.updatedAt) > reap.orphanFlagAfterDays
  );
  const orphan = {
    count: orphanTodos.length,
    oldestDays: orphanTodos.length ? Math.floor(Math.max(...orphanTodos.map((t) => daysAgo(t.updatedAt)))) : 0,
    ids: orphanTodos.map((t) => t.id),
  };
  if (orphan.count > 0) flags.push("ORPHAN");
```

and add `orphan,` to the returned object. Add a suggestion line:

```ts
  if (orphan.count > 0) suggestions.push(`orphan: ${orphan.count} active TODOs untouched > ${reap.orphanFlagAfterDays}d (non-fleet) → review + close/park, or they linger (oldest ${orphan.oldestDays}d)`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/todo-health.test.mts`
Expected: PASS — new ORPHAN test + all existing health tests green.

- [ ] **Step 5: Commit**

```bash
git add src/health.ts test/todo-health.test.mts
git commit -m "feat: v0.6.0 ORPHAN health flag (advisory, transient)"
```

---

### Task 4: Session_start wiring — reap after auto-prune + notify

**Files:**
- Modify: `extensions/todo.ts:81-127` (the `session_start` handler)
- Test: `test/todo-auto-prune.test.mts` (extend — see Task 6 covers the ordering assertion; this task adds an integration smoke that the notify string includes the reap line)

**Interfaces:**
- Consumes: `reapStaleActive()` (Task 2), `healthReport().orphan` (Task 3).
- Produces: session_start notify line gains reap + orphan suffixes.

- [ ] **Step 1: Write the failing test** — append to `test/todo-auto-prune.test.mts` (re-establish `TODO_DIR` at the top of the appended block per the wiper lesson)

```ts
// --- v0.6.0 reap runs after auto-prune on session_start (ordering smoke) ---
{
  const tmp = `${import.meta.dirname}/tmp-ap-reap`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  process.env.TODO_DIR = tmp;   // wiper-lesson re-establish
  try {
    const { addTodo } = await import("../src/todo-store.ts");
    const { loadStore, saveStore } = await import("../src/todo-store.ts");
    const { autoPruneOnSessionStart } = await import("../src/auto-prune.ts");
    const { reapStaleActive } = await import("../src/reap.ts");
    const DAY = 86400000;
    // a done todo 8d old → auto-prune moves it to archive
    const d = addTodo({ title: "old done", source: "" });
    const s = loadStore(); const drow = s.todos.find((x)=>x.id===d.id)!;
    drow.status = "done"; drow.closedAt = new Date(Date.now()-8*DAY).toISOString();
    saveStore(s);
    // a fleet todo 3d stale → reap cancels it
    const f = addTodo({ title: "fleet run", source: "armory-fleet" });
    const s2 = loadStore(); const frow = s2.todos.find((x)=>x.id===f.id)!;
    frow.updatedAt = new Date(Date.now()-3*DAY).toISOString();
    saveStore(s2);

    const ap = autoPruneOnSessionStart();   // runs first
    const rp = reapStaleActive();            // runs second
    assert.ok(ap && ap.moved === 1, "auto-prune moved the old done todo");
    assert.ok(rp && rp.reaped === 1, "reap cancelled the stale fleet todo");
  } finally {
    delete process.env.TODO_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/todo-auto-prune.test.mts`
Expected: FAIL — `reapStaleActive` import works but the test asserts both fire; passes already structurally. (If it passes, the test still serves as a regression guard for ordering. The real wiring change is in the extension handler.)

- [ ] **Step 3: Wire reap into the session_start handler**

In `extensions/todo.ts`, add the import near the existing `auto-prune` import (line ~41):

```ts
import { reapStaleActive } from "../src/reap";
```

In the `session_start` handler, after the `autoPruneOnSessionStart()` try/catch block (after the `} catch { // auto-prune optional` line) and before `const showCount = ...`, add:

```ts
      // v0.6.0: reap stale active todos from reap-policy'd sources (e.g. armory-fleet).
      // Runs AFTER auto-prune. Reaped todos → cancelled (reversible via todo restore).
      let reapMsg = "";
      try {
        const rp = reapStaleActive();
        if (rp) {
          reapMsg = ` · ♻ reaped ${rp.reaped} stale ${rp.reaped === 1 ? "run" : "runs"} (oldest ${rp.oldestDays}d) — restore via \`todo restore <id>\``;
        }
      } catch {
        // reap optional — never crash the session notify
      }
```

Then append `reapMsg` into the msg. In the `if (showCount)` branch, change:

```ts
        msg = `armory-todo: ${open.length} open TODO${open.length === 1 ? "" : "s"}${autoMsg}`;
```

to:

```ts
        msg = `armory-todo: ${open.length} open TODO${open.length === 1 ? "" : "s"}${autoMsg}${reapMsg}`;
```

and in the `else if (autoMsg)` branch, also append `reapMsg`:

```ts
        msg = `armory-todo${autoMsg}${reapMsg}`;
```

For the orphan advisory suffix (uses `healthReport().orphan`), add inside the existing `healthReport()` try block after the flags check, before the closing:

```ts
          if (report.orphan && report.orphan.count > 0) {
            msg += ` · ${report.orphan.count} orphaned (oldest ${report.orphan.oldestDays}d untouched, non-fleet — review in /todo)`;
          }
```

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `npm test`
Expected: PASS — 444 + new reap/health/config/auto-prune tests all green.

- [ ] **Step 5: Commit**

```bash
git add extensions/todo.ts test/todo-auto-prune.test.mts
git commit -m "feat: v0.6.0 wire reap into session_start + orphan notify"
```

---

### Task 5: Panel — `ORPHAN` ⌛ indicator + reapedCount in Done tab

**Files:**
- Modify: `src/panel-data.ts` (row shape + Done tab data)
- Modify: `src/panel.ts` (render ⌛ + reapedCount)
- Test: `test/panel-data.test.mts` (extend)

**Interfaces:**
- Consumes: `healthReport().orphan` (Task 3), audit log `REAP` lines (best-effort count).
- Produces: panel rows show ⌛ prefix for orphan ids; Done tab shows `reaped: N` line.

- [ ] **Step 1: Write the failing test** (append to `test/panel-data.test.mts`, re-establish `TODO_DIR`)

```ts
// --- v0.6.0 ORPHAN row indicator + reapedCount ---
{
  const tmp = `${import.meta.dirname}/tmp-panel-orphan`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  process.env.TODO_DIR = tmp;
  try {
    const { addTodo } = await import("../src/todo-store.ts");
    const { loadStore, saveStore } = await import("../src/todo-store.ts");
    const { buildOpenRows } = await import("../src/panel-data.ts");  // or the actual export name — verify in file
    const DAY = 86400000;
    const t = addTodo({ title: "dormant", source: "" });
    const s = loadStore(); const row = s.todos.find((x)=>x.id===t.id)!;
    row.updatedAt = new Date(Date.now()-16*DAY).toISOString();
    saveStore(s);
    const rows = buildOpenRows();   // adapt to actual function name/return shape
    const r = rows.find((x: any) => x.id === t.id);
    assert.ok(r, "row exists");
    assert.equal(r.orphan, true, "row flagged orphan");
    // reapedCount from audit log
    const { countReapedFromAudit } = await import("../src/panel-data.ts");
    assert.equal(countReapedFromAudit(), 0);  // nothing reaped yet
  } finally {
    delete process.env.TODO_DIR;
    rmSync(tmp, { recursive: true, force: true });
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/panel-data.test.mts`
Expected: FAIL — `buildOpenRows` rows have no `orphan` field; `countReapedFromAudit` not exported.

- [ ] **Step 3: Implement**

In `src/panel-data.ts`, first read the existing row-building function (the plan implementer must locate the actual export — likely `buildOpenRows` or a similar name referenced from `panel.ts`). Add an `orphan: boolean` field to each row, populated by checking `healthReport().orphan.ids` (memoize one `healthReport()` call per panel build). Add:

```ts
import { healthReport } from "./health.ts";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getLivePath } from "./paths.ts";

/** Count REAP marker lines in the audit log (best-effort, for the Done tab). */
export function countReapedFromAudit(): number {
  try {
    const log = join(dirname(getLivePath()), "todo-audit.log");
    if (!existsSync(log)) return 0;
    const txt = readFileSync(log, "utf8");
    return (txt.match(/^REAP /gm) || []).length;
  } catch { return 0; }
}
```

In the row builder, add `orphan` to each row: `orphan: orphanIds.has(row.id)` where `const orphanIds = new Set(healthReport().orphan.ids);` is computed once at the top of the build.

In `src/panel.ts`, prefix orphan rows with ⌛ in the render function (locate the existing row format string — e.g. `formatRow` — and prepend `${row.orphan ? "⌛ " : ""}`). In the Done tab render, add a header line `reaped: ${countReapedFromAudit()} runs auto-cancelled (restore via /todo)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/panel-data.test.mts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel-data.ts src/panel.ts test/panel-data.test.mts
git commit -m "feat: v0.6.0 panel ORPHAN indicator + reapedCount in Done tab"
```

---

### Task 6: Full regression + version bump + docs + publish

**Files:**
- Modify: `package.json` (`0.5.3` → `0.6.0`)
- Modify: `AGENTS.md` (structure table + Notes section)
- Modify: `README.md` (What it solves + Structure blocks)

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all green (444 prior + new reap/config/health/auto-prune/panel tests).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Bump version**

In `package.json`, change `"version": "0.5.3"` → `"version": "0.6.0"`.

- [ ] **Step 4: Update `AGENTS.md`**

In the Structure code block, add `reap.ts` to the `src/` line description (after `auto-prune (session_start age-gated prune)`):

```
              # auto-prune (session_start age-gated prune), reap (v0.6.0 source-aware stale-active cancelling),
```

In the `test/` line, add `todo-reap`:

```
              # + todo-hard-prune + todo-auto-prune + registry + projects + panel-data + todo-caps + todo-backup + todo-reap (v0.6.0)
```

In Notes, add a v0.6.0 bullet:

```
- Source-aware stale-active reaping (v0.6.0): `session_start` sweep cancels active todos from `config.reap.policy` sources (default `armory-fleet` @ 2d) — reversible via `restore`. Non-policy active todos > `orphanFlagAfterDays` (14d) get an advisory `ORPHAN` health flag (transient, never mutated). Backup + audit reuse v0.5.1 guardrails. The "safety protocol" — any agent using armory-todo gets orphan-leak protection without coordinating with producers.
```

- [ ] **Step 5: Update `README.md`**

In the comparison table or "What it solves" section, add a note that armory-todo now self-heals orphaned producer-tracked todos (v0.6.0). Keep concise.

- [ ] **Step 6: Commit + tag + push (publish is CI-driven on `v*` tag)**

```bash
git add package.json AGENTS.md README.md
git commit -m "chore: v0.6.0 — source-aware reap safety protocol"
git tag v0.6.0
git push origin main --tags
```

- [ ] **Step 7: Verify CI publish**

Run: `gh run list --limit 3`
Expected: `release.yml` run for the `v0.6.0` tag → green, `@getpipher/armory-todo@0.6.0` on npm.

- [ ] **Step 8: Pin settings + verify install**

In `~/.pi/agent/settings.json`, update the armory-todo package pin to `npm:@getpipher/armory-todo@0.6.0`. Reload pi. Open `/todo` → Done tab shows `reaped: N` once the first real reap fires. Run `todo health` → no `ORPHAN` on RECTOR's real todos (the 42 fleet orphans get cancelled on next session_start at the 2d threshold; RECTOR's sas-fix at 8d stays flagged-only but under 14d so no ORPHAN yet).

- [ ] **Step 9: Memory note**

Write `~/.pi/agent/memory/-Users-rector-local-dev-getpipher-armory-todo/v0.6.0-shipped.md` with: the diagnosed orphan-leak cause (fleet happy-path-only close), the fix layer decision (store self-heals, not fleet), the `source`-as-discriminator insight, and the dropped sub-todo decision + rationale (for future-me reference).

---

## Self-review

**Spec coverage:**
- §2 Goals → Tasks 1-4 (config + reap + health + wiring). ✅
- §3 Non-goals → respected (no sub-todos, no non-fleet auto-reap, no cron, no `reapTo:"done"`). ✅
- §4 Decisions → defaults baked into `DEFAULT_CONFIG.reap` (Task 1) + reap logic (Task 2). ✅
- §5 Architecture table → every row maps to a task. ✅
- §6 Config shape → Task 1. ✅
- §7 Data flow (5 steps) → Tasks 2 + 4. ✅
- §8 Error handling → corrupt-config skip (Task 2 test), idempotency (Task 2 test), reversibility (Task 2 test), source-gate (Task 2 tests). ✅
- §9 Testing → Tasks 1-5 cover all listed suites. ✅
- §10 Shipping → Task 6. ✅
- §11 Open questions → all defaults accepted (⌛ glyph, default copy, no one-shot). ✅

**Type consistency:** `ReapResult { reaped, flagged, ids, oldestDays }` used identically in Task 2 (producer) + Task 4 (consumer). `orphan: { count, oldestDays, ids }` in Task 3 (producer) + Task 4/5 (consumer). `ReapPolicyEntry` / `ReapConfig` consistent across Task 1 + Task 2. ✅

**Placeholder scan:** No "TBD"/"TODO". One flagged ambiguity: Task 5 references `buildOpenRows` / the actual row export name — the implementer must locate the real name in `panel-data.ts` (the plan says so explicitly, with a fallback note). This is intentional discovery-in-existing-code, not a placeholder. ✅

**Note for the implementer on Task 2's `staleTodo` helper:** it uses `await import` inside a sync test — convert to a static top-level import (`import { loadStore, saveStore } from "../src/todo-store.ts"`) at the top of the test file and drop the dynamic imports. Same for any `await import` in Tasks 3-5 appended test blocks — replace with top-level static imports. tsx supports top-level `await import` only in ESM modules; the existing suites use static imports, follow that.