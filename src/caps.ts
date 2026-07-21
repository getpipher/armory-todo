// Caps enforcement primitives for armory-todo (v0.5.0). Pure — no disk I/O,
// no config/registry loads. Callers (addTodo/updateTodo/renderOpenBlock) load
// state and pass it in, so these are unit-testable in isolation.
//
// Two caps:
//   - notes  : per-todo byte ceiling (health.maxNotesBytes), hard-reject at write.
//   - project: per-project open-count ceiling (registry maxOpen), hard-reject
//              on add + project-move (only for open/in_progress todos).
// Both throw TodoError BEFORE any store mutation (callers ensure atomicity).
//
// Circular import note: caps.ts imports TodoError/Todo (types) from
// todo-store.ts; todo-store.ts imports the cap functions. Safe — no module
// touches another's exports at top level; all usage is inside functions, so
// both are fully loaded by call-time.

import { TodoError, type Todo } from "./todo-store.ts";
import type { ProjectRegistry } from "./registry.ts";

/** Human-readable byte size for error messages: 512 -> "512B", 2048 -> "2.0KB". */
function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/** Throw if notes exceeds the byte cap. Byte-length (not char-length): notes
 *  can hold Unicode ("é" = 2 bytes UTF-8). A maxBytes of 0 means "no notes
 *  allowed" (only empty notes pass). Negative maxBytes rejects everything
 *  (treated as a misconfig; config load clamps negative/NaN to the default). */
export function checkNotesCap(notes: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(notes, "utf8");
  if (bytes > maxBytes) {
    throw new TodoError(
      `notes ${formatBytes(bytes)} > max ${formatBytes(maxBytes)} (maxNotesBytes ${maxBytes}) — trim the detail or split into multiple todos`,
    );
  }
}

export interface ProjectCapInput {
  project: string;        // target project name (already trimmed by caller)
  currentOpen: number;     // target's current open count, NOT counting the would-be-added/moved todo
  maxOpen: number | null;  // from the registry entry; null = uncapped
}

/** Throw if adding one more open todo to `project` would exceed its cap.
 *  `maxOpen === null` -> no-op (uncapped). The cap is on the `open` count only
 *  (matches the PROJECT_OVER health definition; in_progress does not count). */
export function checkProjectCap({ project, currentOpen, maxOpen }: ProjectCapInput): void {
  if (maxOpen === null) return;
  if (currentOpen + 1 > maxOpen) {
    throw new TodoError(
      `project '${project}' is at maxOpen ${maxOpen} (${currentOpen} open) — close/park one, or raise maxOpen via the /todo panel (Projects tab -> Set maxOpen), before adding`,
    );
  }
}

export interface OverBudgetProject { name: string; open: number; maxOpen: number; }

/** Projects whose open count exceeds their explicit maxOpen (maxOpen non-null).
 *  Pure; consumed by renderOpenBlock's over-cap summary. `liveTodos` is the
 *  full live store array. Open is counted here (status === "open"). Sorted by
 *  breach depth (open - maxOpen) desc, then name asc. */
export function overBudgetProjects(liveTodos: Todo[], registry: ProjectRegistry): OverBudgetProject[] {
  const out: OverBudgetProject[] = [];
  for (const entry of registry.projects) {
    if (entry.maxOpen === null) continue;
    const open = liveTodos.filter((t) => t.project === entry.name && t.status === "open").length;
    if (open > entry.maxOpen) out.push({ name: entry.name, open, maxOpen: entry.maxOpen });
  }
  return out.sort((a, b) => (b.open - b.maxOpen) - (a.open - a.maxOpen) || a.name.localeCompare(b.name));
}