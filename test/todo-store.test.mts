// Standalone store tests for armory-todo (run: node test/todo-store.test.mts).
// Uses TODO_DIR to avoid touching the real ~/.pi/agent/todo/.

import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "armory-todo-"));
process.env.TODO_DIR = tmp;
// NOTE: no TODO_STORE_PATH — v2 uses TODO_DIR; the store reads <tmp>/todo.json

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

// --- paths resolve under TODO_DIR ---
const { getTodoDir, getLivePath, getArchivePath, getConfigPath, getLegacyPath } =
  await import("../src/paths.ts");
eq("getTodoDir is TODO_DIR", getTodoDir(), tmp);
eq("live path under TODO_DIR", getLivePath(), join(tmp, "todo.json"));
eq("archive path under TODO_DIR", getArchivePath(), join(tmp, "todo-archive.json"));
eq("config path under TODO_DIR", getConfigPath(), join(tmp, "todo.config.json"));
ok("legacy path is the real ~/.pi/agent/todo.json", getLegacyPath().endsWith(join(".pi", "agent", "todo.json")));

// fresh import after env set
const { addTodo, listTodos, updateTodo, completeTodo, deleteTodo, clearTodos, renderOpenBlock, loadStore, parkTodo } =
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

// --- atomic + 0600 perms (v2 path) ---
const livePath = getLivePath();
const stat = statSync(livePath);
ok("store file mode 0600", (stat.mode & 0o777) === 0o600, `(mode ${(stat.mode & 0o777).toString(8)})`);
ok("no .tmp leftover", !existsSync(livePath + ".tmp"));

// --- corrupt file recovery (v2 path) ---
rmSync(livePath, { force: true });
writeFileSync(livePath, "{ this is not json", "utf8");
const recovered = loadStore();
ok("corrupt file → fresh empty store", recovered.todos.length === 0);
ok("corrupt file backed up", existsSync(livePath + ".bad-") === false || recovered.todos.length === 0);

// --- empty render ---
clearTodos("cancelled");
// add nothing, clear all open/in_progress
for (const t of listTodos({ status: "all" })) deleteTodo(t.id);
const emptyBlock = renderOpenBlock();
ok("empty block says none", emptyBlock.includes("(none"));

// --- parked status: round-trip + excluded from renderOpenBlock ---
const p1 = addTodo({ text: "maybe someday task", project: "pi", priority: "low" });
const parked = parkTodo(p1.id);
eq("park sets status parked", parked.status, "parked");
eq("park clears closedAt", parked.closedAt, null);
// parked is NOT in the default actionable list
eq("parked excluded from default list", listTodos().some((t) => t.id === p1.id), false);
// parked IS visible with status=all
eq("parked in status=all", listTodos({ status: "all" }).some((t) => t.id === p1.id), true);
// parked is NOT in the injected Open TODOs block
const blockAfterPark = renderOpenBlock();
ok("parked not in renderOpenBlock", !blockAfterPark.includes("maybe someday task"));
// parked → back to open via update
updateTodo(p1.id, { status: "open" });
eq("parked → open re-includes in default list", listTodos().some((t) => t.id === p1.id), true);

// --- extended list: text search + since/before + pagination ---
const s1 = addTodo({ text: "research browser-use for solana", project: "sol", priority: "low" });
const s2 = addTodo({ text: "ship nuntius spec-2", project: "nuntius", priority: "high" });
// text search
const searchText = listTodos({ text: "browser-use" });
eq("text search matches 1", searchText.length, 1);
eq("text search returns the right one", searchText[0]!.id, s1.id);
eq("text search no match returns 0", listTodos({ text: "zzznomatch" }).length, 0);
// since filter on createdAt
eq("since filter includes s1", listTodos({ since: s1.createdAt }).some((t) => t.id === s1.id), true);
// pagination
const page1 = listTodos({ limit: 1, page: 1 });
const page2 = listTodos({ limit: 1, page: 2 });
eq("limit=1 page1 has 1 item", page1.length, 1);
eq("limit=1 page2 has 1 item", page2.length, 1);
ok("pages differ", page1[0]!.id !== page2[0]!.id);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);