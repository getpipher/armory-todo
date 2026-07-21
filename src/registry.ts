// Project registry for armory-todo — a sibling file to todo.json holding the
// canonical list of known projects + their per-project advisory cap slot
// (`maxOpen`). Advisory in v0.4.0 (drives a health flag); enforcement
// (block-on-add) graduates in v0.5.0.
//
// File: <TODO_DIR>/projects.json (0600, atomic write). Lazy-synced on read:
// `reconcileRegistry` appends any unknown project strings (live + archived)
// with maxOpen:null. `loadRegistry` is side-effect-free (missing → empty,
// no file created); seeding happens on the first reconcile call.
// No env guard — projects.json always lives under TODO_DIR (temp dir in tests).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getTodoDir } from "./paths.ts";
import { loadStore, saveStore, TodoError, type Todo } from "./todo-store.ts";
import { loadArchive, saveArchive } from "./archive.ts";

export interface ProjectEntry {
  name: string;
  maxOpen: number | null;  // null = no advisory cap for this project
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRegistry {
  version: 1;
  updatedAt: string;
  projects: ProjectEntry[];
}

function now(): string { return new Date().toISOString(); }

function emptyRegistry(): ProjectRegistry {
  return { version: 1, updatedAt: now(), projects: [] };
}

export function getRegistryPath(): string {
  return join(getTodoDir(), "projects.json");
}

export function loadRegistry(): ProjectRegistry {
  const path = getRegistryPath();
  if (!existsSync(path)) return emptyRegistry();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ProjectRegistry;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.projects)) {
      throw new Error("invalid registry shape");
    }
    if (parsed.version !== 1) throw new Error("invalid registry shape");
    return parsed;
  } catch {
    try {
      renameSync(path, `${path}.bad-${Date.now()}`);
    } catch {
      // best-effort backup
    }
    return emptyRegistry();
  }
}

export function saveRegistry(reg: ProjectRegistry): void {
  reg.updatedAt = now();
  const path = getRegistryPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* fs may ignore mode bits */ }
  renameSync(tmp, path);
}

/**
 * Lazy sync: append any unknown non-empty project strings (from live + archived
 * todos) as new entries with maxOpen:null. Returns { reg, changed }. Caller
 * persists iff changed. Idempotent (a second call with no new names → changed=false).
 */
export function reconcileRegistry(
  reg: ProjectRegistry,
  liveTodos: Todo[],
  archivedTodos: Todo[],
): { reg: ProjectRegistry; changed: boolean } {
  const known = new Set(reg.projects.map((p) => p.name));
  const names = new Set<string>();
  for (const t of liveTodos) { const p = t.project.trim(); if (p) names.add(p); }
  for (const t of archivedTodos) { const p = t.project.trim(); if (p) names.add(p); }
  let changed = false;
  for (const name of names) {
    if (!known.has(name)) {
      reg.projects.push({ name, maxOpen: null, createdAt: now(), updatedAt: now() });
      changed = true;
    }
  }
  if (changed) reg.updatedAt = now();
  return { reg, changed };
}

export function getProjectEntry(reg: ProjectRegistry, name: string): ProjectEntry | undefined {
  return reg.projects.find((p) => p.name === name);
}

/**
 * Set a project's maxOpen slot. `max = null` clears. Creates the entry if the
 * name is unknown (with createdAt/updatedAt = now). Throws if name is "" (the
 * (no project) group can't be capped). Mutates `reg` in place + returns the entry.
 */
export function setProjectMaxOpen(reg: ProjectRegistry, name: string, max: number | null): ProjectEntry {
  const trimmed = name.trim();
  if (!trimmed) throw new TodoError("cannot set maxOpen on the (no project) group");
  if (max !== null && (!Number.isFinite(max) || max < 0)) {
    throw new TodoError(`maxOpen must be a non-negative number or null (got ${String(max)})`);
  }
  let entry = getProjectEntry(reg, trimmed);
  if (!entry) {
    entry = { name: trimmed, maxOpen: null, createdAt: now(), updatedAt: now() };
    reg.projects.push(entry);
  }
  entry.maxOpen = max;
  entry.updatedAt = now();
  reg.updatedAt = now();
  return entry;
}

export interface RenameResult {
  liveRenamed: number;
  archivedRenamed: number;
  merged: boolean;
  newName: string;
}

/**
 * Rename (or merge) a project: rewrite every live + archived todo whose
 * `project === oldName` to `newName`, remove the `oldName` registry entry,
 * and ensure the `newName` entry exists. Best-effort multi-file (no WAL):
 * live → archive → registry, each saved atomically with backup-on-corrupt.
 * Throws if `oldName` is not in the registry. Self-rename is a no-op success.
 */
export function renameProject(oldName: string, newName: string): RenameResult {
  const old = oldName.trim();
  const next = newName.trim();
  if (!old) throw new TodoError("oldName is required");
  if (!next) throw new TodoError("newName is required");
  if (old === next) return { liveRenamed: 0, archivedRenamed: 0, merged: false, newName: next };

  const reg = loadRegistry();
  const oldEntry = getProjectEntry(reg, old);
  if (!oldEntry) throw new TodoError(`no project named '${old}' in the registry`);
  const merged = getProjectEntry(reg, next) !== undefined;

  // 1. live store
  const live = loadStore();
  let liveRenamed = 0;
  for (const t of live.todos) {
    if (t.project === old) { t.project = next; t.updatedAt = now(); liveRenamed++; }
  }
  if (liveRenamed > 0) saveStore(live);

  // 2. archive
  const archive = loadArchive();
  let archivedRenamed = 0;
  for (const t of archive.todos) {
    if (t.project === old) { t.project = next; archivedRenamed++; }
  }
  if (archivedRenamed > 0) saveArchive(archive);

  // 3. registry: remove old, ensure next exists
  reg.projects = reg.projects.filter((p) => p.name !== old);
  if (!getProjectEntry(reg, next)) {
    reg.projects.push({ name: next, maxOpen: null, createdAt: now(), updatedAt: now() });
  }
  reg.updatedAt = now();
  saveRegistry(reg);

  return { liveRenamed, archivedRenamed, merged, newName: next };
}