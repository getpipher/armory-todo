// Bloat diagnostics for armory-todo — a pure-read report across all three
// lifecycle boxes (active / parked / archive), driven by the heuristics in
// todo.config.json. No side effects. The agent surfaces this + suggestions,
// then waits for user confirmation before any `prune --hard` (SPEC-2).

import { loadStore } from "./todo-store.ts";
import { loadArchive } from "./archive.ts";
import { loadConfig } from "./config.ts";
import { loadRegistry, reconcileRegistry, saveRegistry, getProjectEntry } from "./registry.ts";
import { levenshtein } from "./levenshtein.ts";

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
  maxId: string | null;   // v0.5.0: id of the todo with the largest notes (null if no todos)
  avg: number;
}

export type HealthFlag =
  | "ACTIVE_LARGE" | "ACTIVE_STALE"
  | "PARKED_LARGE" | "PARKED_STALE"
  | "ARCHIVE_LARGE" | "ARCHIVE_OLD"
  | "NOTES_OVER"
  | "PROJECT_OVER" | "PROJECT_TYPO" | "PROJECT_LARGE" | "PROJECT_STALE"
  | "ORPHAN";

export interface ProjectHealth {
  name: string;
  open: number;
  maxOpen: number | null;
  over: boolean;
  typo: boolean;
  large: boolean;
  stale: boolean;
  lastUpdated: string;
}

export interface HealthReport {
  active: ActiveHealth;
  parked: ParkedHealth;
  archive: ArchiveHealth;
  notesBytes: NotesBytes;
  orphan: { count: number; oldestDays: number; ids: string[] };
  flags: HealthFlag[];
  suggestions: string[];
  projects: ProjectHealth[];   // only projects with ≥1 flag, sorted open desc
  noProject: { open: number };  // (no project) open count, for context
}

function daysAgo(iso: string): number {
  return (Date.now() - Date.parse(iso)) / 86400_000;
}

export function healthReport(): HealthReport {
  const config = loadConfig();
  const h = config.health;
  const live = loadStore();
  const archive = loadArchive();

  // reconcile registry first (lazy sync), persist iff changed
  const reg = loadRegistry();
  const { reg: synced, changed } = reconcileRegistry(reg, live.todos, archive.todos);
  if (changed) saveRegistry(synced);

  const openTodos = live.todos.filter((t) => t.status === "open");
  const ipTodos = live.todos.filter((t) => t.status === "in_progress");
  const parkedTodos = live.todos.filter((t) => t.status === "parked");
  const actionable = [...openTodos, ...ipTodos];

  // v0.6.0: policy-source stale actives are auto-reaped elsewhere; non-policy
  // stale actives are advisory-only ORPHANs. Derived on every read, never persisted.
  const policySources = new Set(Object.keys(config.reap.policy));
  const orphanTodos = actionable.filter((t) =>
    !policySources.has(t.source) && daysAgo(t.updatedAt) > config.reap.orphanFlagAfterDays
  );
  const orphan = {
    count: orphanTodos.length,
    oldestDays: orphanTodos.length
      ? Math.floor(Math.max(...orphanTodos.map((t) => daysAgo(t.updatedAt))))
      : 0,
    ids: orphanTodos.map((t) => t.id),
  };

  const activeStale = openTodos.filter((t) => daysAgo(t.updatedAt) > h.activeStaleDays).length;
  const parkedStale = parkedTodos.filter((t) => daysAgo(t.updatedAt) > h.parkedStaleDays).length;
  const archiveOld = archive.todos.filter((t) => t.closedAt && daysAgo(t.closedAt) > h.archiveOldDays).length;

  // notes bytes across active + parked (archived excluded — sealed history).
  // v0.5.0: track the worst-offender id so the NOTES_OVER suggestion is actionable.
  const apTodos = [...openTodos, ...ipTodos, ...parkedTodos];
  let maxId: string | null = null;
  let maxSize = 0;
  let totalBytes = 0;
  for (const t of apTodos) {
    const s = Buffer.byteLength(t.notes, "utf8");
    totalBytes += s;
    if (s > maxSize) { maxSize = s; maxId = t.id; }
  }
  const notesBytes: NotesBytes = {
    total: totalBytes,
    max: maxSize,
    maxId: apTodos.length ? maxId : null,
    avg: apTodos.length ? Math.round(totalBytes / apTodos.length) : 0,
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
  if (notesBytes.max > h.maxNotesBytes) flags.push("NOTES_OVER");
  if (activeStale > 0) flags.push("ACTIVE_STALE");
  if (orphan.count > 0) flags.push("ORPHAN");
  if (parkedTodos.length > h.parkedMax) flags.push("PARKED_LARGE");
  if (parkedStale > 0) flags.push("PARKED_STALE");
  if (archive.todos.length > h.archiveMax) flags.push("ARCHIVE_LARGE");
  if (archiveOld > 0) flags.push("ARCHIVE_OLD");

  const suggestions: string[] = [];
  if (archiveOld > 0) suggestions.push(`archive: ${archiveOld} items older than ${h.archiveOldDays}d → consider \`prune --hard --box archive --older-than ${h.archiveOldDays} --confirm\``);
  if (activeStale > 0) suggestions.push(`active: ${activeStale} open TODOs untouched for ${h.activeStaleDays}d → park or close them`);
  if (orphan.count > 0) suggestions.push(`orphan: ${orphan.count} active TODOs untouched > ${config.reap.orphanFlagAfterDays}d (non-policy source) → review + close/park (oldest ${orphan.oldestDays}d)`);
  if (parkedStale > 0) suggestions.push(`parked: ${parkedStale} parked > ${h.parkedStaleDays}d → restore or hard-prune`);
  if (actionable.length > h.activeMaxOpen) suggestions.push(`active: ${actionable.length} open+in_progress (max ${h.activeMaxOpen}) → close or park some before adding more`);
  if (notesBytes.max > h.maxNotesBytes) {
    const id = notesBytes.maxId ?? "<id>";
    suggestions.push(`notes: largest note ${notesBytes.max}B > cap ${h.maxNotesBytes}B (on ${id}) → trim via todo update ${id} notes:…`);
  }

  // per-project flags (v0.4.0)
  const archivedDone = archive.todos.filter((t) => t.status === "done");
  const projectNames = new Set<string>();
  for (const t of live.todos) { const p = t.project.trim(); if (p) projectNames.add(p); }
  for (const t of archivedDone) { const p = t.project.trim(); if (p) projectNames.add(p); }

  const projectHealth: ProjectHealth[] = [];
  for (const name of projectNames) {
    const liveForName = live.todos.filter((t) => t.project.trim() === name);
    const open = liveForName.filter((t) => t.status === "open").length;
    const entry = getProjectEntry(synced, name);
    const maxOpen = entry?.maxOpen ?? null;
    const over = maxOpen !== null && open > maxOpen;
    const large = open > h.perProjectDefaultMax;
    const lastUpdated = liveForName.length ? liveForName.map((t) => t.updatedAt).sort().at(-1) ?? "" : "";
    const stale = lastUpdated !== "" && daysAgo(lastUpdated) > h.activeStaleDays;
    const totalForName = liveForName.length + archivedDone.filter((t) => t.project.trim() === name).length;
    const typo = totalForName === 1 && [...projectNames].some((o) => o !== name && levenshtein(name, o) <= 2);
    if (over || large || stale || typo) {
      projectHealth.push({ name, open, maxOpen, over, typo, large, stale, lastUpdated });
    }
  }
  projectHealth.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));

  for (const p of projectHealth) {
    if (p.over) { flags.push("PROJECT_OVER"); suggestions.push(`project '${p.name}' ${p.open} open (maxOpen ${p.maxOpen}) → close/park some, or raise maxOpen`); }
    if (p.large) { flags.push("PROJECT_LARGE"); suggestions.push(`project '${p.name}' ${p.open} open (per-project default max ${h.perProjectDefaultMax}) → over budget`); }
    if (p.stale) { flags.push("PROJECT_STALE"); suggestions.push(`project '${p.name}' untouched > ${h.activeStaleDays}d → park or close`); }
    if (p.typo) {
      flags.push("PROJECT_TYPO");
      const sib = [...projectNames].find((o) => o !== p.name && levenshtein(p.name, o) <= 2);
      suggestions.push(`project '${p.name}' has 1 todo — possible typo of '${sib}'? → todo project rename ${p.name} ${sib}`);
    }
  }

  const noProject = { open: live.todos.filter((t) => t.project.trim() === "" && t.status === "open").length };

  return { active, parked, archive: arch, notesBytes, orphan, flags, suggestions, projects: projectHealth, noProject };
}
