// The ONLY irreversible deletion path in armory-todo. Everything else is
// reversible (park = status flip, prune = archive move, restore = move back).
// hardPrune permanently deletes todos from the targeted box.
//
// Structural gate: refuses to execute unless `confirm: true` is passed. Even
// if the agent hallucinates intent, the tool demands the flag. The prompt
// guidelines (extensions/todo.ts) instruct the agent to always surface the
// `health` report + the exact proposed command and wait for an explicit user
// "yes" before passing confirm. The slash path uses ctx.ui.confirm.

import { loadStore, saveStore } from "./todo-store.ts";
import { loadArchive, saveArchive } from "./archive.ts";
import type { Todo } from "./todo-store.ts";

export type HardPruneBox = "archive" | "active" | "parked";

export interface HardPruneInput {
  confirm: boolean;            // REQUIRED — must be true to execute
  box?: HardPruneBox;          // default: "archive"
  olderThan?: number;          // days; filters by updatedAt (active/parked) or closedAt (archive)
  project?: string;
  tag?: string;
}

export interface HardPruneResult {
  refused: boolean;
  deleted: number;
  ids: string[];
  message: string;
}

function daysAgo(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86400_000;
}

/**
 * Permanently delete todos from a box. The only irreversible action.
 * Returns `{ refused: true, deleted: 0, ... }` unless `confirm: true`.
 */
export function hardPrune(opts: HardPruneInput): HardPruneResult {
  if (!opts.confirm) {
    return {
      refused: true,
      deleted: 0,
      ids: [],
      message: "Refused: pass confirm:true to execute hard-prune (this permanently deletes).",
    };
  }
  const box: HardPruneBox = opts.box ?? "archive";
  const cutoff = opts.olderThan ? Date.now() - opts.olderThan * 86400_000 : null;

  const matches = (t: Todo): boolean => {
    if (opts.project && t.project !== opts.project) return false;
    if (opts.tag && !t.tags.includes(opts.tag)) return false;
    if (cutoff !== null) {
      const dateField = box === "archive" ? (t.closedAt ?? t.updatedAt) : t.updatedAt;
      if (Date.parse(dateField) > cutoff) return false;
    }
    return true;
  };

  if (box === "archive") {
    const archive = loadArchive();
    const kept: Todo[] = [];
    const deleted: Todo[] = [];
    for (const t of archive.todos) (matches(t) ? deleted : kept).push(t);
    if (deleted.length === 0) return { refused: false, deleted: 0, ids: [], message: "No archived todos matched the criteria." };
    archive.todos = kept;
    saveArchive(archive);
    return { refused: false, deleted: deleted.length, ids: deleted.map((t) => t.id), message: `Permanently deleted ${deleted.length} archived todo${deleted.length === 1 ? "" : "s"}.` };
  }

  // active or parked box → live store
  const live = loadStore();
  const targetStatuses = box === "parked" ? ["parked"] : ["open", "in_progress"];
  const kept: Todo[] = [];
  const deleted: Todo[] = [];
  for (const t of live.todos) {
    if (targetStatuses.includes(t.status) && matches(t)) {
      deleted.push(t);
    } else {
      kept.push(t);
    }
  }
  if (deleted.length === 0) return { refused: false, deleted: 0, ids: [], message: `No ${box} todos matched the criteria.` };
  live.todos = kept;
  saveStore(live);
  return { refused: false, deleted: deleted.length, ids: deleted.map((t) => t.id), message: `Permanently deleted ${deleted.length} ${box} todo${deleted.length === 1 ? "" : "s"}.` };
}