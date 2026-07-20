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
import { loadStore, saveStore } from "./todo-store.ts";

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