// Bloat diagnostics for armory-todo — a pure-read report across all three
// lifecycle boxes (active / parked / archive), driven by the heuristics in
// todo.config.json. No side effects. The agent surfaces this + suggestions,
// then waits for user confirmation before any `prune --hard` (SPEC-2).

import { loadStore } from "./todo-store.ts";
import { loadArchive } from "./archive.ts";
import { loadConfig } from "./config.ts";

export interface ActiveHealth {
  open: number;
  in_progress: number;
  stale_30d: number;       // open todos with updatedAt older than activeStaleDays
}

export interface ParkedHealth {
  count: number;
  stale_60d: number;       // parked with updatedAt older than parkedStaleDays
}

export interface ArchiveHealth {
  count: number;
  older_180d: number;      // closedAt older than archiveOldDays
}

export interface NotesBytes {
  total: number;
  max: number;
  avg: number;
}

export type HealthFlag =
  | "ACTIVE_LARGE" | "ACTIVE_STALE"
  | "PARKED_LARGE" | "PARKED_STALE"
  | "ARCHIVE_LARGE" | "ARCHIVE_OLD";

export interface HealthReport {
  active: ActiveHealth;
  parked: ParkedHealth;
  archive: ArchiveHealth;
  notesBytes: NotesBytes;
  flags: HealthFlag[];
  suggestions: string[];
}

function daysAgo(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86400_000;
}

export function healthReport(): HealthReport {
  const config = loadConfig();
  const h = config.health;
  const live = loadStore();
  const archive = loadArchive();

  const openTodos = live.todos.filter((t) => t.status === "open");
  const ipTodos = live.todos.filter((t) => t.status === "in_progress");
  const parkedTodos = live.todos.filter((t) => t.status === "parked");
  const actionable = [...openTodos, ...ipTodos];

  const activeStale = openTodos.filter((t) => daysAgo(t.updatedAt) > h.activeStaleDays).length;
  const parkedStale = parkedTodos.filter((t) => daysAgo(t.updatedAt) > h.parkedStaleDays).length;
  const archiveOld = archive.todos.filter((t) => t.closedAt && daysAgo(t.closedAt) > h.archiveOldDays).length;

  // notes bytes across active + parked (archived excluded — sealed history).
  const apTodos = [...openTodos, ...ipTodos, ...parkedTodos];
  const notesSizes = apTodos.map((t) => Buffer.byteLength(t.notes, "utf8"));
  const notesBytes: NotesBytes = {
    total: notesSizes.reduce((a, b) => a + b, 0),
    max: notesSizes.length ? Math.max(...notesSizes) : 0,
    avg: notesSizes.length ? Math.round(notesSizes.reduce((a, b) => a + b, 0) / notesSizes.length) : 0,
  };

  const active: ActiveHealth = {
    open: openTodos.length,
    in_progress: ipTodos.length,
    stale_30d: activeStale,
  };
  const parked: ParkedHealth = { count: parkedTodos.length, stale_60d: parkedStale };
  const arch: ArchiveHealth = { count: archive.todos.length, older_180d: archiveOld };

  const flags: HealthFlag[] = [];
  if (actionable.length > h.activeMaxOpen) flags.push("ACTIVE_LARGE");
  if (activeStale > 0) flags.push("ACTIVE_STALE");
  if (parkedTodos.length > h.parkedMax) flags.push("PARKED_LARGE");
  if (parkedStale > 0) flags.push("PARKED_STALE");
  if (archive.todos.length > h.archiveMax) flags.push("ARCHIVE_LARGE");
  if (archiveOld > 0) flags.push("ARCHIVE_OLD");

  const suggestions: string[] = [];
  if (archiveOld > 0) suggestions.push(`archive: ${archiveOld} items older than ${h.archiveOldDays}d → consider \`prune --hard --box archive --older-than ${h.archiveOldDays} --confirm\``);
  if (activeStale > 0) suggestions.push(`active: ${activeStale} open TODOs untouched for ${h.activeStaleDays}d → park or close them`);
  if (parkedStale > 0) suggestions.push(`parked: ${parkedStale} parked > ${h.parkedStaleDays}d → restore or hard-prune`);
  if (actionable.length > h.activeMaxOpen) suggestions.push(`active: ${actionable.length} open+in_progress (max ${h.activeMaxOpen}) → close or park some before adding more`);

  return { active, parked, archive: arch, notesBytes, flags, suggestions };
}