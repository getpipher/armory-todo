// Path resolution for the armory-todo folder layout (v2).
//
// All store files live under TODO_DIR (default ~/.pi/agent/todo/):
//   todo.json          — live store (open, in_progress, parked)
//   todo-archive.json  — sealed history (done, cancelled)
//   todo.config.json   — prune ages + health thresholds
//   projects.json      — project registry (canonical names + maxOpen slots, v0.4.0)
//
// The legacy v1 single file was ~/.pi/agent/todo.json; migrate.ts handles
// moving it into the folder on first load.

import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DIR = join(homedir(), ".pi", "agent", "todo");
const LEGACY_PATH = join(homedir(), ".pi", "agent", "todo.json");

export function getTodoDir(): string {
  return process.env.TODO_DIR || DEFAULT_DIR;
}

export function getLivePath(): string {
  return join(getTodoDir(), "todo.json");
}

export function getArchivePath(): string {
  return join(getTodoDir(), "todo-archive.json");
}

export function getConfigPath(): string {
  return join(getTodoDir(), "todo.config.json");
}

export function getRegistryPath(): string {
  return join(getTodoDir(), "projects.json");
}

/** The pre-v2 single-file store location. Used by migrate.ts. */
export function getLegacyPath(): string {
  return LEGACY_PATH;
}