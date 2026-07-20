import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
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

const tmp = mkdtempSync(join(tmpdir(), "armory-archive-"));
process.env.TODO_DIR = tmp;
// Pre-Task-9 rewire: the live store still reads TODO_STORE_PATH. Point it at the
// same temp file the v2 folder will use (<tmp>/todo.json) so prune/restore don't
// touch the real ~/.pi/agent/todo.json. Task 9 drops this once loadStore reads
// getLivePath() under TODO_DIR.
process.env.TODO_STORE_PATH = join(tmp, "todo.json");

const { loadArchive, saveArchive } = await import("../src/archive.ts");
import type { Todo } from "../src/todo-store.ts";

// --- missing archive → empty store, no file created ---
const empty = loadArchive();
eq("missing archive → 0 todos", empty.todos.length, 0);
eq("archive version 2", empty.version, 2);
ok("archive file not created on bare load", !existsSync(join(tmp, "todo-archive.json")));

// --- save + reload round-trip ---
const sample: Todo = { id: "td-arch1", text: "finished thing", project: "pi", tags: [], priority: "med", status: "done", source: "test", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z", closedAt: "2026-07-02T00:00:00Z" };
saveArchive({ version: 2, updatedAt: "2026-07-02T00:00:00Z", todos: [sample] });
ok("archive file created on save", existsSync(join(tmp, "todo-archive.json")));
const reloaded = loadArchive();
eq("archive reload count", reloaded.todos.length, 1);
eq("archive reload id", reloaded.todos[0]!.id, "td-arch1");

// --- 0600 perms + atomic (no .tmp leftover) ---
const mode = statSync(join(tmp, "todo-archive.json")).mode & 0o777;
ok("archive file mode 0600", mode === 0o600, `(mode ${mode.toString(8)})`);
ok("no archive .tmp leftover", !existsSync(join(tmp, "todo-archive.json.tmp")));

// --- prune: age-based move to archive ---
const { pruneTodos, loadArchive: reloadArch } = await import("../src/archive.ts");
const { addTodo, completeTodo, loadStore, saveStore, deleteTodo } = await import("../src/todo-store.ts");
import { writeFileSync } from "node:fs";

// Set up a live store with: one old-done (prunable), one fresh-done (not prunable), one open (never pruned)
const livePath = process.env.TODO_STORE_PATH!;
const oldDate = new Date(Date.now() - 30 * 86400_000).toISOString(); // 30 days ago
const freshDate = new Date().toISOString();
writeFileSync(livePath, JSON.stringify({
  version: 1, updatedAt: freshDate,
  todos: [
    { id: "td-old-done", text: "old done", project: "", tags: [], priority: "med", status: "done", source: "", createdAt: oldDate, updatedAt: oldDate, closedAt: oldDate },
    { id: "td-fresh-done", text: "fresh done", project: "", tags: [], priority: "med", status: "done", source: "", createdAt: freshDate, updatedAt: freshDate, closedAt: freshDate },
    { id: "td-open", text: "still open", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: freshDate, updatedAt: freshDate, closedAt: null },
  ],
}, null, 2), "utf8");

// prune with age=7 days → only the old-done moves
const result = pruneTodos({ ageDays: 7 });
eq("prune moved 1 (age-based)", result.moved, 1);
eq("prune moved the old one", result.ids[0], "td-old-done");
const archAfter = reloadArch();
ok("archive has the old-done", archAfter.todos.some((t) => t.id === "td-old-done"));
const liveAfter = loadStore();
ok("fresh-done stays in live", liveAfter.todos.some((t) => t.id === "td-fresh-done"));
ok("open stays in live", liveAfter.todos.some((t) => t.id === "td-open"));
ok("old-done gone from live", !liveAfter.todos.some((t) => t.id === "td-old-done"));

// prune --all → fresh-done also moves
const result2 = pruneTodos({ all: true });
eq("prune --all moved 1 (the fresh-done)", result2.moved, 1);
const liveAfter2 = loadStore();
ok("fresh-done gone after --all", !liveAfter2.todos.some((t) => t.id === "td-fresh-done"));
ok("open still in live after --all", liveAfter2.todos.some((t) => t.id === "td-open"));

// cancelled also pruned
const c1 = addTodo({ text: "to cancel", priority: "low" });
deleteTodo(c1.id);
const result3 = pruneTodos({ all: true });
ok("prune --all also moved cancelled", result3.moved >= 1);

// --- restore: archive → live as open ---
const { restoreTodo } = await import("../src/archive.ts");

// archive currently has the old-done + fresh-done + cancelled from earlier
const before = loadArchive();
const archId = before.todos[0]!.id;
const restored = restoreTodo(archId);
eq("restore sets status open", restored.status, "open");
eq("restore clears closedAt", restored.closedAt, null);
const archAfterRestore = loadArchive();
ok("restore removed from archive", !archAfterRestore.todos.some((t) => t.id === archId));
const liveAfterRestore = loadStore();
ok("restore added to live", liveAfterRestore.todos.some((t) => t.id === archId));
ok("restored is open in live", liveAfterRestore.todos.find((t) => t.id === archId)!.status === "open");

// --- restore of a non-archived id errors ---
let threw = false;
try {
  restoreTodo("td-does-not-exist");
} catch {
  threw = true;
}
ok("restore non-archived id throws", threw);

// --- listArchived: filters + pagination ---
const { listArchived, archiveSummary } = await import("../src/archive.ts");

const summary = archiveSummary();
ok("summary has total >= 1", summary.total >= 1);
ok("summary byProject is an object", typeof summary.byProject === "object");
ok("summary byMonth is an object", typeof summary.byMonth === "object");

const allArch = listArchived({ since: "2000-01-01", limit: 100 });
ok("listArchived returns items + total", allArch.items.length >= 1 && allArch.total >= 1);
// bare call → summary-only (items: [])
const bare = listArchived();
eq("bare listArchived returns empty items", bare.items.length, 0);
ok("bare listArchived has summary", bare.summary !== undefined);
// pagination
const archPage1 = listArchived({ text: "done", limit: 1, page: 1 });
const archPage2 = listArchived({ text: "done", limit: 1, page: 2 });
ok("arch limit=1 page1 has <=1", archPage1.items.length <= 1);
// text search on archived
const archSearch = listArchived({ text: "done", limit: 100 });
ok("arch text search works", archSearch.items.every((t) => t.text.includes("done")));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);