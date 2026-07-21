import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
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

const { loadArchive, saveArchive } = await import("../src/archive.ts");
import type { Todo } from "../src/todo-store.ts";
import { getLivePath } from "../src/paths.ts";

// --- missing archive → empty store, no file created ---
const empty = loadArchive();
eq("missing archive → 0 todos", empty.todos.length, 0);
eq("archive version 3", empty.version, 3);
ok("archive file not created on bare load", !existsSync(join(tmp, "todo-archive.json")));

// --- save + reload round-trip ---
const sample: Todo = { id: "td-arch1", title: "finished thing", notes: "", project: "pi", tags: [], priority: "med", status: "done", source: "test", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z", closedAt: "2026-07-02T00:00:00Z" };
saveArchive({ version: 3, updatedAt: "2026-07-02T00:00:00Z", todos: [sample] });
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
const livePath = getLivePath();
const oldDate = new Date(Date.now() - 30 * 86400_000).toISOString(); // 30 days ago
const freshDate = new Date().toISOString();
writeFileSync(livePath, JSON.stringify({
  version: 3, updatedAt: freshDate,
  todos: [
    { id: "td-old-done", title: "old done", notes: "", project: "", tags: [], priority: "med", status: "done", source: "", createdAt: oldDate, updatedAt: oldDate, closedAt: oldDate },
    { id: "td-fresh-done", title: "fresh done", notes: "", project: "", tags: [], priority: "med", status: "done", source: "", createdAt: freshDate, updatedAt: freshDate, closedAt: freshDate },
    { id: "td-open", title: "still open", notes: "", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: freshDate, updatedAt: freshDate, closedAt: null },
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
const c1 = addTodo({ title: "to cancel", priority: "low" });
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
ok("arch text search works", archSearch.items.every((t) => t.title.includes("done")));

// --- v2 archive → v3 on load (symmetric with live store) ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-arc-v3-"));
  process.env.TODO_DIR = dir;
  const arcFile = join(dir, "todo-archive.json");
  writeFileSync(arcFile, JSON.stringify({
    version: 2, updatedAt: "x",
    todos: [{ id: "td-arc-1", text: "done thing\nwith detail", project: "pi", tags: [], priority: "med", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: "2026-07-01T00:00:00Z" }],
  }), "utf8");
  const { loadArchive, listArchived } = await import("../src/archive.ts");
  const arc = loadArchive();
  ok("archive v2→v3: version 3", arc.version === 3);
  ok("archive v2→v3: title derived", arc.todos[0]!.title === "done thing");
  ok("archive v2→v3: notes derived", arc.todos[0]!.notes === "with detail");
  ok("archive v2→v3: no text field", !("text" in arc.todos[0]!));
  // persisted to disk
  const onDisk = JSON.parse(readFileSync(arcFile, "utf8"));
  ok("archive v2→v3: disk version 3", onDisk.version === 3);
  // listArchived text filter matches title OR notes
  const byTitle = listArchived({ text: "done thing", limit: 50 });
  ok("archive listArchived text matches title", byTitle.items.some((t) => t.title === "done thing"));
  const byNotes = listArchived({ text: "with detail", limit: 50 });
  ok("archive listArchived text matches notes", byNotes.items.some((t) => t.notes === "with detail"));
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// --- pruneTodos rich result (items + ageDays) ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-prune-rich-"));
  process.env.TODO_DIR = dir;
  const { pruneTodos } = await import("../src/archive.ts");
  const { addTodo, completeTodo, deleteTodo, loadStore, saveStore } = await import("../src/todo-store.ts");
  const { loadArchive } = await import("../src/archive.ts");
  const old = addTodo({ title: "old done", notes: "x" }); completeTodo(old.id);
  const fresh = addTodo({ title: "fresh done", notes: "y" }); completeTodo(fresh.id);
  const cancelled = addTodo({ title: "cancelled old", notes: "z" }); deleteTodo(cancelled.id);
  const st = loadStore();
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  for (const t of st.todos) {
    if (t.id === old.id || t.id === cancelled.id) { t.closedAt = thirtyAgo; t.updatedAt = thirtyAgo; }
  }
  saveStore(st);
  const res = pruneTodos({ ageDays: 7 });
  ok("rich: moved 2 (old done + old cancelled; fresh stays)", res.moved === 2);
  ok("rich: items length matches moved", res.items.length === res.moved);
  ok("rich: items have title", res.items.every((i) => typeof i.title === "string" && i.title.length > 0));
  ok("rich: items have status done|cancelled", res.items.every((i) => i.status === "done" || i.status === "cancelled"));
  const oldItem = res.items.find((i) => i.id === old.id)!;
  ok("rich: old done ageDays ~30", oldItem.ageDays >= 29 && oldItem.ageDays <= 31);
  ok("rich: ids still present (back-compat)", res.ids.length === res.moved);
  ok("rich: fresh done stays in live", loadStore().todos.some((t) => t.id === fresh.id));
  ok("rich: old done + cancelled in archive", loadArchive().todos.length === 2);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// --- listDoneUnified: live done + archived done, excludes cancelled, sorted newest-closed first ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-done-unified-"));
  process.env.TODO_DIR = dir;
  const { listDoneUnified, saveArchive } = await import("../src/archive.ts");
  const { addTodo, completeTodo, deleteTodo, loadStore, saveStore } = await import("../src/todo-store.ts");
  const liveRecent = addTodo({ title: "live recent done", notes: "lr" }); completeTodo(liveRecent.id);
  const liveOld = addTodo({ title: "live older done", notes: "lo" }); completeTodo(liveOld.id);
  const st = loadStore();
  const t = st.todos.find((x) => x.id === liveOld.id)!;
  const tenAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
  t.closedAt = tenAgo; t.updatedAt = tenAgo;
  saveStore(st);
  const archDone: any = { id: "td-arch-d", title: "archived done old", notes: "", project: "pi", tags: [], priority: "med", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: new Date(Date.now() - 40 * 86400_000).toISOString() };
  const archCancelled: any = { id: "td-arch-c", title: "archived cancelled", notes: "", project: "", tags: [], priority: "med", status: "cancelled", source: "", createdAt: "x", updatedAt: "x", closedAt: new Date(Date.now() - 40 * 86400_000).toISOString() };
  saveArchive({ version: 3, updatedAt: "x", todos: [archDone, archCancelled] });
  const liveCancelled = addTodo({ title: "live cancelled", notes: "" }); deleteTodo(liveCancelled.id);

  const all = listDoneUnified({});
  ok("unified: 3 done (live recent + live older + archived done)", all.length === 3);
  ok("unified: excludes cancelled (live + archived)", !all.some((d) => d.status === "cancelled"));
  ok("unified: live done tagged location live", all.filter((d) => d.location === "live").length === 2);
  ok("unified: archived done tagged location archive", all.filter((d) => d.location === "archive").length === 1);
  eq("unified: sorted newest-closed first", all[0]!.id, liveRecent.id);
  eq("unified: oldest last", all[2]!.id, "td-arch-d");
  const byNotes = listDoneUnified({ text: "lr" });
  ok("unified: text filter matches notes", byNotes.length === 1 && byNotes[0]!.id === liveRecent.id);
  const byProj = listDoneUnified({ project: "pi" });
  ok("unified: project filter", byProj.every((d) => d.project === "pi"));
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);