// Sealed history store for armory-todo — holds done/cancelled todos moved
// here by `prune`. Recoverable via `restore`; permanently deletable only via
// `prune --hard` (SPEC-2). Never auto-injected into the system prompt.
//
// File: <TODO_DIR>/todo-archive.json (0600, atomic write). Missing on disk
// → empty store returned; the file is created on first save, not first load.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getArchivePath } from "./paths.ts";
import type { Todo } from "./todo-store.ts";
import { loadConfig } from "./config.ts";
import { loadStore, saveStore, TodoError } from "./todo-store.ts";

export interface ArchiveStore {
  version: 2;
  updatedAt: string;
  todos: Todo[];
}

function now(): string {
  return new Date().toISOString();
}

function emptyArchive(): ArchiveStore {
  return { version: 2, updatedAt: now(), todos: [] };
}

/** Load the archive. Missing file → empty store (no file created). */
export function loadArchive(): ArchiveStore {
  const path = getArchivePath();
  if (!existsSync(path)) return emptyArchive();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as ArchiveStore;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.todos)) {
      throw new Error("invalid archive shape");
    }
    return parsed;
  } catch {
    try {
      renameSync(path, `${path}.bad-${Date.now()}`);
    } catch {
      // best-effort backup
    }
    return emptyArchive();
  }
}

/** Atomic, 0600 write. */
export function saveArchive(store: ArchiveStore): void {
  store.updatedAt = now();
  const path = getArchivePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // some filesystems ignore mode bits
  }
  renameSync(tmp, path);
}

export interface PruneInput {
  ageDays?: number;
  all?: boolean;
  statuses?: ("done" | "cancelled")[];
}

export interface PruneResult {
  moved: number;
  ids: string[];
}

/**
 * Move done/cancelled todos from the live store to the archive.
 *
 * A todo qualifies when:
 *   - its status is in `statuses` (default: config.prune.statuses = done+cancelled), AND
 *   - `all` is true, OR its `closedAt` is older than `ageDays` days ago
 *     (default: config.prune.defaultAgeDays).
 *
 * Both stores are saved atomically. Reversible via `restoreTodo`.
 */
export function pruneTodos(opts: PruneInput = {}): PruneResult {
  const config = loadConfig();
  const ageDays = opts.ageDays ?? config.prune.defaultAgeDays;
  const statuses = new Set(opts.statuses ?? config.prune.statuses);
  const cutoff = opts.all ? null : Date.now() - ageDays * 86400_000;

  const live = loadStore();
  const archive = loadArchive();

  const moved: Todo[] = [];
  const kept: Todo[] = [];
  for (const todo of live.todos) {
    if (!statuses.has(todo.status as "done" | "cancelled")) {
      kept.push(todo);
      continue;
    }
    if (cutoff !== null && todo.closedAt && Date.parse(todo.closedAt) > cutoff) {
      // too fresh — keep in live
      kept.push(todo);
      continue;
    }
    moved.push(todo);
  }

  if (moved.length === 0) return { moved: 0, ids: [] };

  live.todos = kept;
  archive.todos.push(...moved);
  saveStore(live);
  saveArchive(archive);

  return { moved: moved.length, ids: moved.map((t) => t.id) };
}

/**
 * Move an archived todo back to the live store as `open` (closedAt cleared).
 * Throws TodoError if the id is not in the archive. Both stores are saved.
 */
export function restoreTodo(id: string): Todo {
  const archive = loadArchive();
  const idx = archive.todos.findIndex((t) => t.id === id);
  if (idx < 0) throw new TodoError(`not in archive: ${id}`);
  const [todo] = archive.todos.splice(idx, 1);
  const live = loadStore();
  todo.status = "open";
  todo.closedAt = null;
  todo.updatedAt = now();
  live.todos.push(todo);
  saveStore(live);
  saveArchive(archive);
  return todo;
}

export interface ArchiveListFilter {
  project?: string;
  tag?: string;
  status?: "done" | "cancelled";
  text?: string;
  since?: string;    // by closedAt
  before?: string;   // by closedAt
  limit?: number;    // default 20
  page?: number;     // default 1
}

export interface ArchiveSummary {
  total: number;
  byProject: Record<string, number>;
  byMonth: Record<string, number>;
}

export interface ArchiveListResult {
  items: Todo[];
  total: number;       // total matching the filter (before pagination)
  summary?: ArchiveSummary;  // present only on a bare call (no filters)
}

/** Counts by project + by closedAt-month, for the summary-first default. */
export function archiveSummary(): ArchiveSummary {
  const archive = loadArchive();
  const byProject: Record<string, number> = {};
  const byMonth: Record<string, number> = {};
  for (const t of archive.todos) {
    const proj = t.project || "(none)";
    byProject[proj] = (byProject[proj] ?? 0) + 1;
    const month = t.closedAt ? t.closedAt.slice(0, 7) : "(none)"; // YYYY-MM
    byMonth[month] = (byMonth[month] ?? 0) + 1;
  }
  return { total: archive.todos.length, byProject, byMonth };
}

/**
 * Query the archive with filters + pagination. A bare call (no filters)
 * returns summary-only (items: []) — drill down with a filter to get rows.
 */
export function listArchived(filter: ArchiveListFilter = {}): ArchiveListResult {
  const hasFilter = Boolean(filter.project || filter.tag || filter.status || filter.text || filter.since || filter.before);
  if (!hasFilter) {
    const summary = archiveSummary();
    return { items: [], total: summary.total, summary };
  }
  let out = loadArchive().todos;
  if (filter.project) out = out.filter((t) => t.project === filter.project);
  if (filter.tag) out = out.filter((t) => t.tags.includes(filter.tag as string));
  if (filter.status) out = out.filter((t) => t.status === filter.status);
  if (filter.text) {
    const q = filter.text.toLowerCase();
    out = out.filter((t) => t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q));
  }
  if (filter.since) out = out.filter((t) => (t.closedAt ?? t.updatedAt) >= (filter.since as string));
  if (filter.before) out = out.filter((t) => (t.closedAt ?? t.updatedAt) < (filter.before as string));
  // sort newest-closed first
  const sorted = out.slice().sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
  const total = sorted.length;
  const limit = filter.limit ?? 20;
  const page = filter.page ?? 1;
  const start = (page - 1) * limit;
  return { items: sorted.slice(start, start + limit), total };
}