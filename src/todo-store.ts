// Pure, pi-independent TODO store for armory-todo.
//
// A global, cross-session TODO list backed by a JSON file under TODO_DIR
// (default ~/.pi/agent/todo/todo.json). The live store holds open, in_progress,
// and parked todos; done/cancelled are moved to todo-archive.json by `prune`
// (see archive.ts). v1 single-file stores at ~/.pi/agent/todo.json are
// migrated into the folder on first load (see migrate.ts).
//
// Kept free of any pi/typebox imports so it can be unit-tested standalone.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getLivePath, getTodoDir, getLegacyPath } from "./paths.ts";
import { migrateIfNeeded } from "./migrate.ts";

export type Priority = "low" | "med" | "high" | "critical";
export type Status = "open" | "in_progress" | "parked" | "done" | "cancelled";

const PRIO_ORDER: Record<Priority, number> = { critical: 0, high: 1, med: 2, low: 3 };
const PRIORITIES: Priority[] = ["low", "med", "high", "critical"];
const STATUSES: Status[] = ["open", "in_progress", "parked", "done", "cancelled"];
const PRIO_SET = new Set(PRIORITIES);
const STATUS_SET = new Set(STATUSES);

export interface Todo {
  id: string;
  text: string;
  project: string;
  tags: string[];
  priority: Priority;
  status: Status;
  source: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Store {
  version: 2;
  updatedAt: string;
  todos: Todo[];
}

export interface AddInput {
  text: string;
  project?: string;
  tags?: string[];
  priority?: Priority;
  source?: string;
}

export interface UpdateInput {
  text?: string;
  project?: string;
  tags?: string[];
  priority?: Priority;
  status?: Status;
}

export interface ListFilter {
  status?: Status | "all";
  project?: string;
  tag?: string;
  text?: string;       // substring match on todo.text (case-insensitive)
  since?: string;      // ISO date; filter createdAt >= since
  before?: string;     // ISO date; filter createdAt < before
  limit?: number;      // default 20
  page?: number;       // default 1 (1-indexed)
}

export class TodoError extends Error {}

function now(): string {
  return new Date().toISOString();
}

/** Monotonic-ish unique id: td-<base36 ms>-<6 random>. */
function genId(): string {
  return "td-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function emptyStore(): Store {
  return { version: 2, updatedAt: now(), todos: [] };
}

export function getStorePath(): string {
  return getLivePath();
}

/** Load the live store from disk. Runs v1→v2 migration first — but ONLY when
 *  using the default TODO_DIR (not overridden by TODO_DIR env, e.g. tests).
 *  On corruption, backs up the bad file and starts fresh. */
export function loadStore(): Store {
  if (!process.env.TODO_DIR) {
    migrateIfNeeded({ todoDir: getTodoDir(), legacyPath: getLegacyPath() });
  }
  const path = getLivePath();
  if (!existsSync(path)) return emptyStore();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.todos)) {
      throw new Error("invalid store shape");
    }
    if (parsed.version !== 2) {
      // v1 → v2: accept it (the migration moved the file), just bump the version in memory.
      // The data shape is otherwise identical; parked status is new but old todos won't have it.
      parsed.version = 2;
    }
    return parsed;
  } catch {
    try {
      renameSync(path, `${path}.bad-${Date.now()}`);
    } catch {
      // best-effort backup; swallow
    }
    return emptyStore();
  }
}

/** Atomic, 0600 write. */
export function saveStore(store: Store): void {
  store.updatedAt = now();
  const path = getLivePath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // some filesystems ignore mode bits; not fatal
  }
  renameSync(tmp, path);
}

function assertPriority(p: unknown): asserts p is Priority {
  if (typeof p !== "string" || !PRIO_SET.has(p as Priority)) {
    throw new TodoError(`invalid priority: ${String(p)} (expected ${PRIORITIES.join("|")})`);
  }
}

function assertStatus(s: unknown): asserts s is Status {
  if (typeof s !== "string" || !STATUS_SET.has(s as Status)) {
    throw new TodoError(`invalid status: ${String(s)} (expected ${STATUSES.join("|")})`);
  }
}

function findOrFail(store: Store, id: string): Todo {
  const t = store.todos.find((x) => x.id === id);
  if (!t) throw new TodoError(`no todo with id ${id}`);
  return t;
}

export function addTodo(input: AddInput): Todo {
  const text = (input.text ?? "").trim();
  if (!text) throw new TodoError("text is required");
  if (input.priority) assertPriority(input.priority);
  const store = loadStore();
  const todo: Todo = {
    id: genId(),
    text,
    project: (input.project ?? "").trim(),
    tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
    priority: input.priority ?? "med",
    status: "open",
    source: (input.source ?? "").trim(),
    createdAt: now(),
    updatedAt: now(),
    closedAt: null,
  };
  store.todos.push(todo);
  saveStore(store);
  return todo;
}

export function listTodos(filter: ListFilter = {}): Todo[] {
  const store = loadStore();
  let out = store.todos;
  if (filter.status && filter.status !== "all") {
    assertStatus(filter.status);
    out = out.filter((t) => t.status === filter.status);
  } else if (!filter.status) {
    // default: actionable set only
    out = out.filter((t) => t.status === "open" || t.status === "in_progress");
  }
  if (filter.project) out = out.filter((t) => t.project === filter.project);
  if (filter.tag) out = out.filter((t) => t.tags.includes(filter.tag as string));
  if (filter.text) {
    const q = filter.text.toLowerCase();
    out = out.filter((t) => t.text.toLowerCase().includes(q));
  }
  if (filter.since) out = out.filter((t) => t.createdAt >= (filter.since as string));
  if (filter.before) out = out.filter((t) => t.createdAt < (filter.before as string));
  const sorted = out.slice().sort((a, b) => {
    if (a.status !== b.status) {
      // in_progress before open (actionable ordering)
      return a.status === "in_progress" ? -1 : b.status === "in_progress" ? 1 : 0;
    }
    if (PRIO_ORDER[a.priority] !== PRIO_ORDER[b.priority]) {
      return PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority];
    }
    return a.createdAt.localeCompare(b.createdAt);
  });
  const limit = filter.limit ?? 20;
  const page = filter.page ?? 1;
  const start = (page - 1) * limit;
  return sorted.slice(start, start + limit);
}

export function updateTodo(id: string, patch: UpdateInput): Todo {
  const store = loadStore();
  const todo = findOrFail(store, id);
  if (patch.text !== undefined) {
    const text = patch.text.trim();
    if (!text) throw new TodoError("text must not be empty");
    todo.text = text;
  }
  if (patch.project !== undefined) todo.project = patch.project.trim();
  if (patch.tags !== undefined) todo.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
  if (patch.priority !== undefined) {
    assertPriority(patch.priority);
    todo.priority = patch.priority;
  }
  if (patch.status !== undefined) {
    assertStatus(patch.status);
    const wasOpen = todo.status === "open" || todo.status === "in_progress";
    const nowDone = patch.status === "done" || patch.status === "cancelled";
    todo.status = patch.status;
    if (wasOpen && nowDone) todo.closedAt = now();
    if (!nowDone) todo.closedAt = null;
  }
  todo.updatedAt = now();
  saveStore(store);
  return todo;
}

export function completeTodo(id: string): Todo {
  return updateTodo(id, { status: "done" });
}

export function parkTodo(id: string): Todo {
  return updateTodo(id, { status: "parked" });
}

export function deleteTodo(id: string): Todo {
  return updateTodo(id, { status: "cancelled" });
}

export function clearTodos(status: Status = "done"): number {
  assertStatus(status);
  const store = loadStore();
  const before = store.todos.length;
  store.todos = store.todos.filter((t) => t.status !== status);
  const removed = before - store.todos.length;
  if (removed > 0) saveStore(store);
  return removed;
}

/** Compact markdown summary of open + in_progress TODOs for system-prompt injection. */
export function renderOpenBlock(max = 15): string {
  const todos = listTodos(); // actionable set, sorted
  if (todos.length === 0) return "## Open TODOs\n(none — no pending cross-session TODOs)\n";
  const shown = todos.slice(0, max);
  const lines = shown.map((t) => {
    const tag = t.project ? ` (${t.project})` : "";
    const pin = t.status === "in_progress" ? " ⏵" : "";
    return `- [${t.id}] (${t.priority})${pin} ${t.text}${tag}`;
  });
  const overflow = todos.length > max ? `\n- … +${todos.length - max} more (use \`todo list\`)` : "";
  return `## Open TODOs (${todos.length})\n${lines.join("\n")}${overflow}\n`;
}