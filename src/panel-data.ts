// Pure data helpers for the /todo TUI panel (SPEC-3). Kept separate from
// panel.ts so they're unit-testable without a terminal — the panel component
// itself is manual-gate only.

import type { SelectItem, SettingItem } from "@earendil-works/pi-tui";
import type { Todo } from "./todo-store.ts";
import type { ArchiveSummary } from "./archive.ts";
import type { TodoConfig } from "./config.ts";

/** Format a todo as a SelectList item: "[id] (prio)⏵ text (project)".
 *  The text is truncated to a readable summary (first ~80 chars) so long
 *  running-log todos don't blow out the row width. The full text is still
 *  accessible via the "Edit text" action in the panel. */
export function todoToItem(t: Todo): SelectItem {
  const pin = t.status === "in_progress" ? " ⏵" : "";
  const proj = t.project ? ` (${t.project})` : "";
  const maxText = 80;
  let text = t.text;
  if (text.length > maxText) {
    // Truncate at the first newline if present (titles are usually the first line),
    // then at maxText chars with an ellipsis.
    const firstLine = text.split("\n")[0]!;
    text = firstLine.length > maxText ? firstLine.slice(0, maxText - 1) + "…" : firstLine + "…";
  }
  return {
    value: t.id,
    label: `[${t.id}] (${t.priority})${pin} ${text}${proj}`,
  };
}

/** Format an archive summary into SelectList items (project + month buckets). */
export function archiveSummaryToItems(s: ArchiveSummary): SelectItem[] {
  const items: SelectItem[] = [{ value: "total", label: `Total: ${s.total}` }];
  for (const [p, n] of Object.entries(s.byProject)) items.push({ value: `project:${p}`, label: `  project ${p}: ${n}` });
  for (const [m, n] of Object.entries(s.byMonth)) items.push({ value: `month:${m}`, label: `  ${m}: ${n}` });
  return items;
}

/** Available actions for a todo, depending on its status. */
export function actionsForTodo(t: Todo): { label: string; action: string }[] {
  const actions: { label: string; action: string }[] = [];
  if (t.status === "open" || t.status === "in_progress") {
    actions.push({ label: "Complete", action: "complete" });
    actions.push({ label: "Park (defer)", action: "park" });
  }
  if (t.status === "parked") {
    actions.push({ label: "Re-activate (open)", action: "open" });
    actions.push({ label: "Complete", action: "complete" });
  }
  if (t.status === "done" || t.status === "cancelled") {
    actions.push({ label: "Restore (from archive)", action: "restore" });
  }
  actions.push({ label: "Edit text", action: "edit" });
  actions.push({ label: "Delete (cancel)", action: "delete" });
  return actions;
}

/** Config → SettingsList rows (editable, live-persist). */
export function configToSettingItems(cfg: TodoConfig): SettingItem[] {
  return [
    { id: "defaultAgeDays", label: "Prune age (days)", currentValue: String(cfg.prune.defaultAgeDays), values: ["3", "7", "14", "30"], description: "Done/cancelled older than this → archive on prune." },
    { id: "hardAgeDays", label: "Hard-prune age (days)", currentValue: String(cfg.prune.hardAgeDays), values: ["90", "180", "365"], description: "Archive items older than this → suggested for hard-prune." },
    { id: "activeMaxOpen", label: "Active max open", currentValue: String(cfg.health.activeMaxOpen), values: ["10", "15", "20", "25"], description: "Bloat flag when open+in_progress exceeds this." },
    { id: "activeStaleDays", label: "Active stale (days)", currentValue: String(cfg.health.activeStaleDays), values: ["14", "30", "60"], description: "Bloat flag when open todos untouched longer than this." },
    { id: "parkedMax", label: "Parked max", currentValue: String(cfg.health.parkedMax), values: ["5", "10", "15"], description: "Bloat flag when parked exceeds this." },
    { id: "parkedStaleDays", label: "Parked stale (days)", currentValue: String(cfg.health.parkedStaleDays), values: ["30", "60", "90"], description: "Bloat flag when parked longer than this." },
    { id: "archiveMax", label: "Archive max", currentValue: String(cfg.health.archiveMax), values: ["100", "200", "500"], description: "Bloat flag when archive exceeds this." },
    { id: "archiveOldDays", label: "Archive old (days)", currentValue: String(cfg.health.archiveOldDays), values: ["90", "180", "365"], description: "Bloat flag when archive items older than this." },
  ];
}