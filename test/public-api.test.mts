// test/public-api.test.mts
import { test } from "node:test";
import { strictEqual } from "node:assert";
import {
  addTodo,
  listTodos,
  updateTodo,
  getTodo,
  completeTodo,
  parkTodo,
  deleteTodo,
  type Todo,
  type AddInput,
  type UpdateInput,
  type ListFilter,
} from "../src/index.ts";

test("public API re-exports the stable store subset", () => {
  strictEqual(typeof addTodo, "function");
  strictEqual(typeof listTodos, "function");
  strictEqual(typeof updateTodo, "function");
  strictEqual(typeof getTodo, "function");
  strictEqual(typeof completeTodo, "function");
  strictEqual(typeof parkTodo, "function");
  strictEqual(typeof deleteTodo, "function");
});

test("public API re-exports the stable types", () => {
  // Type-only import compiles iff the types are exported; this runtime noop
  // is a presence guard for the type names in the module's export surface.
  const _check: AddInput = { title: "x" };
  const _u: UpdateInput = {};
  const _f: ListFilter = {};
  const _t: Todo | undefined = undefined;
  void _check; void _u; void _f; void _t;
  strictEqual(true, true);
});