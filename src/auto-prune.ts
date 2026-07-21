// Auto-prune on session_start — the deterministic age-gated prune that runs
// when the extension loads. Wraps pruneTodos with the config default age; never
// --all (fresh done <defaultAgeDays stays). Returns the rich PruneResult if
// anything moved, else null (caller stays silent). Reversible via restore.

import { pruneTodos, type PruneResult } from "./archive.ts";
import { loadConfig } from "./config.ts";

/** Prune stale done/cancelled (older than config.prune.defaultAgeDays) on
 *  session start. Returns the PruneResult if anything moved, else null. */
export function autoPruneOnSessionStart(): PruneResult | null {
  const config = loadConfig();
  const res = pruneTodos({ ageDays: config.prune.defaultAgeDays });
  return res.moved > 0 ? res : null;
}
