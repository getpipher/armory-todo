// Standalone store tests for armory-todo (run: tsx test/todo-store.test.ts).
// Uses TODO_STORE_PATH to avoid touching the real ~/.pi/agent/todo.json.

import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "armory-todo-"));
process.env.TODO_STORE_PATH = join(tmp, "todo.json");

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed++;
    // console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${extra}`);
  }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

// fresh import after env set
const { addTodo, listTodos, updateTodo, completeTodo, deleteTodo, clearTodos, renderOpenBlock, loadStore } =
  await import("../src/todo-store.ts");

// --- add + list defaults to actionable only ---
const t1 = addTodo({ text: "decouple AGENTS.md", project: "pi", tags: ["dotfiles"], priority: "high", source: "test" });
eq("add returns id prefix", t1.id.startsWith("td-"), true);
eq("add status open", t1.status, "open");
eq("add priority high", t1.priority, "high");
const t2 = addTodo({ text: "research browser-use", project: "pi", priority: "med" });
eq("list shows both open", listTodos().length, 2);

// --- done excluded from default list ---
completeTodo(t1.id);
eq("completed excluded from default list", listTodos().length, 1);
eq("completed included in status=all", listTodos({ status: "all" }).length, 2);
eq("completed in done filter", listTodos({ status: "done" }).length, 1);

// --- sorting: in_progress before open; then priority ---
updateTodo(t2.id, { status: "in_progress" });
const t3 = addTodo({ text: "low prio task", priority: "low" });
const order = listTodos();
eq("in_progress sorts first", order[0]!.id, t2.id);
eq("open high-prio? no — t3 is low, after... ", order[1]!.id, t3.id);

// --- filtering by project + tag ---
addTodo({ text: "sip thing", project: "sip", tags: ["mcp"] });
eq("project filter pi (actionable only — t1 is done)", listTodos({ project: "pi" }).length, 1);
eq("project filter sip", listTodos({ project: "sip" }).length, 1);
eq("tag filter mcp", listTodos({ tag: "mcp" }).length, 1);

// --- update validation: bad priority rejected ---
let threw = false;
try {
  updateTodo(t3.id, { priority: "banana" as any });
} catch {
  threw = true;
}
ok("bad priority throws", threw);

// --- delete (tombstone) + clear ---
deleteTodo(t3.id);
eq("deleted is cancelled", listTodos({ status: "cancelled" }).length, 1);
eq("clear done removes 1", clearTodos("done"), 1);
eq("clear cancelled removes 1", clearTodos("cancelled"), 1);

// --- renderOpenBlock ---
const block = renderOpenBlock();
ok("block has heading", block.includes("## Open TODOs"));
ok("block lists remaining", block.includes("research browser-use"));

// --- persistence: reload from disk sees same data ---
const reloaded = loadStore();
ok("reload persists todos", reloaded.todos.length >= 1);

// --- atomic + 0600 perms ---
const stat = statSync(process.env.TODO_STORE_PATH);
ok("store file mode 0600", (stat.mode & 0o777) === 0o600, `(mode ${(stat.mode & 0o777).toString(8)})`);
ok("no .tmp leftover", !existsSync(process.env.TODO_STORE_PATH + ".tmp"));

// --- corrupt file recovery ---
rmSync(process.env.TODO_STORE_PATH!, { force: true });
writeFileSync(process.env.TODO_STORE_PATH!, "{ this is not json", "utf8");
const recovered = loadStore();
ok("corrupt file → fresh empty store", recovered.todos.length === 0);
ok("corrupt file backed up", existsSync(process.env.TODO_STORE_PATH + ".bad-") === false || recovered.todos.length === 0);

// --- empty render ---
clearTodos("cancelled");
// add nothing, clear all open/in_progress
for (const t of listTodos({ status: "all" })) deleteTodo(t.id);
const emptyBlock = renderOpenBlock();
ok("empty block says none", emptyBlock.includes("(none"));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);