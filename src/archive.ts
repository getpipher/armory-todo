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