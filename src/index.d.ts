// src/index.d.ts
/**
 * Typed declarations for the public stable API of @getpipher/armory-todo.
 *
 * Consumed via the package `exports` `types` condition (see package.json) so
 * that TypeScript consumers type-check against this declaration instead of
 * pulling the raw `.ts` implementation source. Runtime (tsx/jiti/node) uses the
 * `default` condition (`./src/index.ts`).
 *
 * Hand-written (no build step — getpipher convention). Keep in sync with
 * src/index.ts re-exports.
 */
export type Priority = "low" | "med" | "high" | "critical";
export type Status = "open" | "in_progress" | "parked" | "done" | "cancelled";

export interface Todo {
  id: string;
  title: string;
  notes: string;
  project: string;
  tags: string[];
  priority: Priority;
  status: Status;
  source: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface AddInput {
  title: string;
  notes?: string;
  project?: string;
  tags?: string[];
  priority?: Priority;
  source?: string;
}

export interface UpdateInput {
  title?: string;
  notes?: string;
  project?: string;
  tags?: string[];
  priority?: Priority;
  status?: Status;
}

export interface ListFilter {
  status?: Status | "all";
  project?: string;
  tag?: string;
  text?: string;
  since?: string;
  before?: string;
  limit?: number;
  page?: number;
}

export interface Store {
  version: 3;
  updatedAt: string;
  todos: Todo[];
}

export interface SaveStoreOptions {
  intentionalDrop?: "reap" | "prune";
}

export class TodoError extends Error {}

export function addTodo(input: AddInput): Todo;
export function listTodos(filter?: ListFilter): Todo[];
export function updateTodo(id: string, patch: UpdateInput): Todo;
export function getTodo(id: string): Todo;
export function completeTodo(id: string): Todo;
export function parkTodo(id: string): Todo;
export function deleteTodo(id: string): Todo;
export function clearTodos(status?: Status): number;
export function renderOpenBlock(max?: number): string;
export function getStorePath(): string;
export function loadStore(): Store;
export function saveStore(store: Store, options?: SaveStoreOptions): void;