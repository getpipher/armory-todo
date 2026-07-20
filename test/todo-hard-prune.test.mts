import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

const tmp = mkdtempSync(join(tmpdir(), "armory-hardprune-"));
process.env.TODO_DIR = tmp;
process.env.TODO_STORE_PATH = join(tmp, "todo.json");

const { hardPrune } = await import("../src/hard-prune.ts");
const { loadStore, saveStore } = await import("../src/todo-store.ts");
const { loadArchive, saveArchive } = await import("../src/archive.ts");
import type { Todo } from "../src/todo-store.ts";

const now = Date.now();
const oldDate = new Date(now - 200 * 86400_000).toISOString();
const fresh = new Date().toISOString();

// Seed: archive with 5 old + 5 fresh; live with 2 parked + 1 open
const archTodos: Todo[] = [];
for (let i = 0; i < 5; i++) archTodos.push({ id: `td-arch-old-${i}`, text: `old ${i}`, project: i < 2 ? "nuntius" : "", tags: [], priority: "med", status: "done", source: "", createdAt: oldDate, updatedAt: oldDate, closedAt: oldDate });
for (let i = 0; i < 5; i++) archTodos.push({ id: `td-arch-fresh-${i}`, text: `fresh ${i}`, project: "", tags: [], priority: "med", status: "done", source: "", createdAt: fresh, updatedAt: fresh, closedAt: fresh });
saveArchive({ version: 2, updatedAt: fresh, todos: archTodos });

const liveTodos: Todo[] = [
  { id: "td-park-1", text: "parked one", project: "pi", tags: [], priority: "low", status: "parked", source: "", createdAt: fresh, updatedAt: oldDate, closedAt: null },
  { id: "td-park-2", text: "parked two", project: "", tags: [], priority: "low", status: "parked", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
  { id: "td-open-1", text: "open one", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
];
saveStore({ version: 2, updatedAt: fresh, todos: liveTodos });

// --- refuses without confirm ---
const refused = hardPrune({ box: "archive", olderThan: 180 });
ok("refuses without confirm", refused.refused === true);
eq("refused deleted count", refused.deleted, 0);
eq("archive untouched after refuse", loadArchive().todos.length, 10);

// --- deletes with confirm: archive, olderThan 180 → 5 old deleted ---
const result = hardPrune({ box: "archive", olderThan: 180, confirm: true });
ok("not refused with confirm", !result.refused);
eq("deleted 5 old archive items", result.deleted, 5);
eq("archive now has 5", loadArchive().todos.length, 5);
ok("only fresh remain", loadArchive().todos.every((t) => t.id.includes("fresh")));

// --- deletes with project filter ---
saveArchive({ version: 2, updatedAt: fresh, todos: archTodos });
const byProject = hardPrune({ box: "archive", olderThan: 180, project: "nuntius", confirm: true });
eq("project filter deleted 2", byProject.deleted, 2);

// --- targets parked box (live store) ---
saveStore({ version: 2, updatedAt: fresh, todos: liveTodos });
const parkedPrune = hardPrune({ box: "parked", olderThan: 60, confirm: true });
eq("parked prune deleted 1 (the stale one)", parkedPrune.deleted, 1);
const liveAfter = loadStore();
ok("fresh parked survived", liveAfter.todos.some((t) => t.id === "td-park-2"));
ok("stale parked gone", !liveAfter.todos.some((t) => t.id === "td-park-1"));
ok("open survived parked-prune", liveAfter.todos.some((t) => t.id === "td-open-1"));

// --- targets active box (open + in_progress only; parked excluded) ---
saveStore({ version: 2, updatedAt: fresh, todos: [
  { id: "td-stale-open", text: "stale open", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: oldDate, closedAt: null },
  { id: "td-fresh-open", text: "fresh open", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
  { id: "td-parked-survives", text: "parked", project: "", tags: [], priority: "low", status: "parked", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
] });
const activePrune = hardPrune({ box: "active", olderThan: 60, confirm: true });
eq("active prune deleted 1 (stale open)", activePrune.deleted, 1);
const liveAfterActive = loadStore();
ok("fresh open survived", liveAfterActive.todos.some((t) => t.id === "td-fresh-open"));
ok("parked survived active-prune", liveAfterActive.todos.some((t) => t.id === "td-parked-survives"));
ok("stale open gone", !liveAfterActive.todos.some((t) => t.id === "td-stale-open"));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);