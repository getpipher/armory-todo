// Pure data helpers for the /todo TUI panel (SPEC-3). Kept separate from
// panel.ts so they're unit-testable without a terminal — the panel component
// itself is manual-gate only.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SelectItem, SettingItem } from "@earendil-works/pi-tui";
import type { Todo } from "./todo-store.ts";
import { getTodoDir } from "./paths.ts";
import type { DoneItem } from "./archive.ts";
import type { ArchiveSummary } from "./archive.ts";
import type { TodoConfig } from "./config.ts";

/** Format a todo as a SelectList item: "[id] (prio)⏵ (project) • title".
 *  title is already ≤120 chars (enforced at write time), so no truncation is
 *  needed. The • marker shows when notes is non-empty (signals "open the
 *  detail view / use `todo get` for context"). */
export function todoToItem(t: Todo, orphan = false): SelectItem {
  const warning = orphan ? "⌛ " : "";
  const pin = t.status === "in_progress" ? " ⏵" : "";
  const proj = t.project ? ` (${t.project})` : "";
  const dot = t.notes.trim() ? " •" : "";
  return {
    value: t.id,
    label: `${warning}[${t.id}] (${t.priority})${pin}${proj}${dot} ${t.title}`,
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
  actions.push({ label: "Edit title", action: "edit" });
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
    { id: "orphanFlagAfterDays", label: "Orphan flag (days)", currentValue: String(cfg.reap.orphanFlagAfterDays), values: ["7", "14", "30", "60"], description: "Advisory ORPHAN flag for non-policy active todos; never auto-mutates." },
    { id: "armoryFleetReapAfterDays", label: "Fleet reap (days)", currentValue: String(cfg.reap.policy["armory-fleet"]?.reapAfterDays ?? 2), values: ["1", "2", "3", "7"], description: "Stale armory-fleet runs → archived cancelled (immediately restorable)." },
    { id: "parkedMax", label: "Parked max", currentValue: String(cfg.health.parkedMax), values: ["5", "10", "15"], description: "Bloat flag when parked exceeds this." },
    { id: "parkedStaleDays", label: "Parked stale (days)", currentValue: String(cfg.health.parkedStaleDays), values: ["30", "60", "90"], description: "Bloat flag when parked longer than this." },
    { id: "archiveMax", label: "Archive max", currentValue: String(cfg.health.archiveMax), values: ["100", "200", "500"], description: "Bloat flag when archive exceeds this." },
    { id: "archiveOldDays", label: "Archive old (days)", currentValue: String(cfg.health.archiveOldDays), values: ["90", "180", "365"], description: "Bloat flag when archive items older than this." },
    { id: "maxNotesBytes", label: "Notes max bytes", currentValue: String(cfg.health.maxNotesBytes), values: ["2048", "4096", "8192", "16384", "32768"], description: "Hard reject at add/update when notes exceeds this (bytes). 0 = no notes allowed." },
  ];
}

/** Format a done todo (live or archived) as a SelectList item with a
 *  location tag: "[live Nd]" or "[archived YYYY-MM-DD]". */
export function todoDoneItem(d: DoneItem): SelectItem {
  const proj = d.project ? ` (${d.project})` : "";
  const loc = d.location === "archive" && d.archivedAt
    ? ` [archived ${d.archivedAt.slice(0, 10)}]`
    : ` [live ${d.closedAt ? Math.floor((Date.now() - Date.parse(d.closedAt)) / 86400_000) : 0}d]`;
  return { value: d.id, label: `[${d.id}] (done)${proj}${loc} ${d.title}` };
}

/** Actions for a done todo: View detail always; Restore only if archived. */
export function actionsForDoneTodo(d: DoneItem): { label: string; action: string }[] {
  const acts: { label: string; action: string }[] = [{ label: "View detail", action: "view" }];
  if (d.location === "archive") acts.push({ label: "Restore (from archive)", action: "restore" });
  return acts;
}

// v0.4.0 — project overview (Projects tab) helpers.
import type { ProjectsOverview } from "./projects.ts";

/** Format the projects overview into SelectList items. Markers: OVER / typo. */
export function projectOverviewToItems(o: ProjectsOverview): SelectItem[] {
  return o.rows.map((r) => {
    const cap = r.maxOpen !== null ? ` [max:${r.maxOpen}]` : "";
    const over = r.over ? " OVER" : "";
    const typo = r.typo ? " ?typo" : "";
    const last = r.lastUpdated ? ` · ${r.lastUpdated.slice(0, 10)}` : " · (no live)";
    return {
      value: r.name,
      label: `${r.name}  ${r.open}/${r.in_progress}/${r.parked}/${r.done} (total ${r.total})${cap}${over}${typo}${last}`,
    };
  });
}

/** Actions for a project row in the Projects tab. */
export function actionsForProject(): { label: string; action: string }[] {
  return [
    { label: "Rename / merge", action: "rename" },
    { label: "Set maxOpen", action: "setmax" },
    { label: "Filter active to project", action: "filter" },
  ];
}

/** The (no project) summary row — non-selectable (no submenu). */
export function noProjectSummaryItem(o: ProjectsOverview): SelectItem {
  return { value: "__noproject__", label: `(no project): ${o.noProject.count} total · ${o.noProject.open} open` };
}

// v0.8.0 — Triage tab helpers (PRD D5). Humans judge in the panel: rows come
// pre-chipped (mechanical-safe debris defaults to close; everything else to
// keep — zero false-closes), each row is overridable, and ONE batch approval
// executes. These helpers are the headless half; panel.ts renders/drives them.

import type { TriageDecision, CloseReason } from "./triage.ts";
import { gatherCandidates } from "./triage.ts";

export type TriageVerdict =
  | "close-debris" | "close-duplicate" | "close-stale" | "close-shipped"
  | "park" | "keep";

export interface TriagePanelRow {
  id: string;
  title: string;
  project: string;
  categories: string;
  ageDays: number;
  mechanicalSafe: boolean;
  verdict: TriageVerdict;
  survivorId?: string;   // close-duplicate
  evidence?: string;     // close-shipped (and free-text for other closes)
}

/** Conservative defaults (D2): only zero-risk mechanical debris pre-chips to
 *  close; every other candidate starts at keep — closing is always an active
 *  human choice in the panel. */
export function defaultVerdictFor(mechanicalSafe: boolean): TriageVerdict {
  return mechanicalSafe ? "close-debris" : "keep";
}

const VERDICT_CHIP: Record<TriageVerdict, string> = {
  "close-debris": "CLOSE·debris",
  "close-duplicate": "CLOSE·dup",
  "close-stale": "CLOSE·stale",
  "close-shipped": "CLOSE·shipped",
  park: "PARK",
  keep: "keep",
};

export function verdictChip(v: TriageVerdict): string {
  return VERDICT_CHIP[v];
}

/** Panel rows for the Triage tab (gather + conservative default verdicts).
 *  Pure read — nothing mutates until the batch approval in panel.ts. */
export function triagePanelRows(scope?: string): TriagePanelRow[] {
  return gatherCandidates(scope).candidates.map((c) => ({
    id: c.todo.id,
    title: c.todo.title,
    project: c.todo.project,
    categories: c.categories.join("+"),
    ageDays: c.ageDays,
    mechanicalSafe: c.mechanicalSafe,
    verdict: defaultVerdictFor(c.mechanicalSafe),
  }));
}

/** Row → SelectList item: "[id] (CHIP) (project · age · categories) title". */
export function triageRowToItem(row: TriagePanelRow): SelectItem {
  const proj = row.project || "no project";
  const safe = row.mechanicalSafe ? " ⚡" : "";
  return {
    value: row.id,
    label: `[${row.id}] (${VERDICT_CHIP[row.verdict]})${safe} ${proj} · ${row.ageDays}d · ${row.categories} — ${row.title}`,
  };
}

/** Per-row actions in the Triage tab. Every close flavor is an explicit
 *  choice; keep is the safe default. */
export function actionsForTriageRow(): { label: string; action: string }[] {
  return [
    { label: "Verdict: CLOSE debris (fleet-run prompt)", action: "v:close-debris" },
    { label: "Verdict: CLOSE duplicate (needs survivor id)", action: "v:close-duplicate" },
    { label: "Verdict: CLOSE stale-unverified", action: "v:close-stale" },
    { label: "Verdict: CLOSE verified-shipped (needs evidence)", action: "v:close-shipped" },
    { label: "Verdict: PARK (real, low, no date)", action: "v:park" },
    { label: "Verdict: KEEP (leave untouched)", action: "v:keep" },
    { label: "View detail", action: "view" },
  ];
}

export interface BatchPlan {
  decisions: TriageDecision[];
  close: number;
  park: number;
  keep: number;
  errors: string[];   // blocking validation problems (close w/o reason, dup w/o survivor, shipped w/o evidence)
}

/** Build + validate the batch from the current rows. Mirrors the engine's
 *  D2 validation so the panel can surface problems BEFORE executing. */
export function planBatch(rows: TriagePanelRow[]): BatchPlan {
  const decisions: import("./triage.ts").TriageDecision[] = [];
  const errors: string[] = [];
  let close = 0, park = 0, keep = 0;
  for (const r of rows) {
    if (r.verdict === "keep") { keep++; continue; }
    if (r.verdict === "park") {
      park++;
      decisions.push({ id: r.id, verdict: "park" });
      continue;
    }
    close++;
    const reason = r.verdict === "close-debris" ? "debris"
      : r.verdict === "close-duplicate" ? "duplicate"
      : r.verdict === "close-stale" ? "stale-unverified"
      : "verified-shipped";
    if (reason === "duplicate" && !r.survivorId) {
      errors.push(`[${r.id}] duplicate close needs a survivor id (action → set it)`);
    }
    if (reason === "verified-shipped" && !r.evidence) {
      errors.push(`[${r.id}] verified-shipped close needs evidence (action → add it)`);
    }
    decisions.push({
      id: r.id,
      verdict: "close",
      reason: reason as CloseReason,
      evidence: r.evidence || (reason === "debris" ? "mechanical: fleet-run prompt debris (panel-batched)" : undefined),
      confidence: r.mechanicalSafe && reason === "debris" ? "high" : "medium",
      survivorId: r.survivorId,
    });
  }
  return { decisions, close, park, keep, errors };
}

/** One-line batch summary for the arm/confirm bar. */
export function batchSummary(plan: BatchPlan): string {
  return `${plan.close} close / ${plan.park} park / ${plan.keep} keep`;
}

/** Sum the number of runs auto-reaped across REAP audit markers. Best-effort;
 *  malformed/missing logs report zero and never break the panel. */
export function countReapedFromAudit(): number {
  try {
    const path = join(getTodoDir(), "todo-audit.log");
    if (!existsSync(path)) return 0;
    let total = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.startsWith("REAP ")) continue;
      const match = line.match(/\breaped=(\d+)\b/);
      if (match) total += Number(match[1]);
    }
    return total;
  } catch {
    return 0;
  }
}
