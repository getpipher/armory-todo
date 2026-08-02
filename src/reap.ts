// Source-aware stale-active reaping (v0.6.0 safety protocol).
//
// On session_start, after auto-prune, scans active (open/in_progress) todos:
//   - whose `source` is in config.reap.policy AND stale (updatedAt older than
//     policy[source].reapAfterDays) → auto-`cancelled` (reversible via restore).
//   - other active todos older than config.reap.orphanFlagAfterDays → ORPHAN
//     flag (advisory, computed in health.ts — reap does NOT mutate these).
//
// Batch: one loadStore, one saveStore. saveStore already calls backupFile +
// snapshotOnDrop + appendAudit internally (same guardrails as every store write).

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { loadStore, saveStore, type Todo } from "./todo-store.ts";
import { getLivePath } from "./paths.ts";

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
  const reapedStaleDays: number[] = [];   // stale-age (by updatedAt) at decision time, pre-mutation
  let flagged = 0;

  for (const todo of store.todos) {
    if (todo.status !== "open" && todo.status !== "in_progress") continue;
    const ageMs = now - Date.parse(todo.updatedAt);
    const ageDays = ageMs / DAY;
    const entry = policy[todo.source];
    if (entry && ageDays >= entry.reapAfterDays) {
      todo.status = "cancelled";
      todo.closedAt = new Date().toISOString();
      todo.updatedAt = new Date().toISOString();
      reaped.push(todo);
      reapedStaleDays.push(ageDays);
    } else if (!entry && ageDays >= orphanAfter) {
      flagged++;
    }
  }

  if (reaped.length === 0) return null;

  saveStore(store);  // saveStore does backupFile + snapshotOnDrop + appendAudit already

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