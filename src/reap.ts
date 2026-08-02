// Source-aware stale-active reaping (v0.6.0 safety protocol).
//
// On session_start, after auto-prune, scans active (open/in_progress) todos:
//   - whose `source` is in config.reap.policy AND stale (updatedAt older than
//     policy[source].reapAfterDays) → archived `cancelled` (immediately restorable).
//   - other active todos older than config.reap.orphanFlagAfterDays → ORPHAN
//     flag (advisory, computed in health.ts — reap does NOT mutate these).
//
// Batch: one loadStore, one saveStore. saveStore already calls backupFile +
// snapshotOnDrop + appendAudit internally (same guardrails as every store write).

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { loadStore, saveStore, type Todo } from "./todo-store.ts";
import { loadArchive, saveArchive } from "./archive.ts";
import { getLivePath } from "./paths.ts";

export interface ReapResult {
  reaped: number;
  flagged: number;        // non-policy active todos older than orphanFlagAfterDays (advisory count)
  ids: string[];          // reaped ids
  oldestDays: number;     // age of the oldest reaped todo (for notify copy)
}

const DAY = 86_400_000;

/** Reap stale active todos per config.reap.policy into the archive. Returns
 *  the result if any moved, else null (caller stays silent). Non-policy stale
 *  todos are flagged via health.ts (ORPHAN) — counted but never mutated. */
export function reapStaleActive(): ReapResult | null {
  const config = loadConfig();
  const policy = config.reap.policy;
  const orphanAfter = config.reap.orphanFlagAfterDays;
  const now = Date.now();

  const store = loadStore();
  const reaped: Todo[] = [];
  const kept: Todo[] = [];
  const reapedStaleDays: number[] = [];   // stale-age (by updatedAt) at decision time, pre-mutation
  const reapedAt = new Date(now).toISOString();
  let flagged = 0;

  for (const todo of store.todos) {
    if (todo.status !== "open" && todo.status !== "in_progress") {
      kept.push(todo);
      continue;
    }
    const ageMs = now - Date.parse(todo.updatedAt);
    const ageDays = ageMs / DAY;
    const entry = policy[todo.source];
    if (entry && ageDays >= entry.reapAfterDays) {
      todo.status = "cancelled";
      todo.closedAt = reapedAt;
      todo.updatedAt = reapedAt;
      reaped.push(todo);
      reapedStaleDays.push(ageDays);
    } else {
      if (!entry && ageDays >= orphanAfter) flagged++;
      kept.push(todo);
    }
  }

  if (reaped.length === 0) return null;

  // Machine-reaped abandoned runs skip the live terminal-retention window and
  // enter sealed history immediately, so `restoreTodo(id)` works at once.
  const archive = loadArchive();
  const archivedIds = new Set(archive.todos.map((t) => t.id));
  for (const todo of reaped) {
    if (!archivedIds.has(todo.id)) archive.todos.push(todo);
  }
  store.todos = kept;
  // Persist archive first: an interrupted second write may temporarily duplicate
  // an id across boxes, but the next idempotent reap removes the live copy. The
  // inverse order could hide data from both primary stores until backup recovery.
  saveArchive(archive);
  saveStore(store, { intentionalDrop: "reap" }); // backups/snapshot/audit, no false wipe sentinel

  // Append a reap-specific audit marker line (best-effort, no content)
  try {
    appendFileSync(
      join(dirname(getLivePath()), "todo-audit.log"),
      `REAP reaped=${reaped.length} flagged=${flagged} at ${new Date().toISOString()}\n`,
    );
  } catch { /* audit best-effort */ }

  const oldestDays = reapedStaleDays.length ? Math.floor(Math.max(...reapedStaleDays)) : 0;
  return { reaped: reaped.length, flagged, ids: reaped.map((t) => t.id), oldestDays };
}