// src/index.ts
/**
 * Public stable API of @getpipher/armory-todo.
 *
 * This `exports` entry (see package.json) is the stable surface — the functions
 * and types re-exported here. Other `src/*` paths are internal and may change
 * without notice. Depend on `@getpipher/armory-todo` (this public entry), never
 * deep-import `src/*`.
 *
 * Consumers (e.g. @getpipher/armory-fleet) import from here so that evolution
 * of armory-todo is decoupled: a breaking change can only touch a consumer's
 * adapter, never its core, and the version pin + CI typecheck catch drift.
 */
export {
  addTodo,
  listTodos,
  updateTodo,
  getTodo,
  completeTodo,
  parkTodo,
  deleteTodo,
  clearTodos,
  renderOpenBlock,
  getStorePath,
  loadStore,
  saveStore,
} from "./todo-store.ts";

export type {
  Todo,
  AddInput,
  UpdateInput,
  ListFilter,
  Priority,
  Status,
  Store,
} from "./todo-store.ts";

export { TodoError } from "./todo-store.ts";