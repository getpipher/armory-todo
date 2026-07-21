// Auto-prune on session_start — the deterministic age-gated prune.
// Run: node test/todo-auto-prune.test.mts
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

const { autoPruneOnSessionStart } = await import("../src/auto-prune.ts");

function seed(dir: string) {
  process.env.TODO_DIR = dir;
  return dir;
}

// Case 1: stale done (>7d) + stale cancelled (>7d) → auto-pruned; fresh done + open untouched
{
  const dir = seed(mkdtempSync(join(tmpdir(), "armory-ap1-")));
  const { addTodo, completeTodo, deleteTodo, loadStore, saveStore } = await import("../src/todo-store.ts");
  const { loadArchive } = await import("../src/archive.ts");
  const staleDone = addTodo({ title: "stale done", notes: "" }); completeTodo(staleDone.id);
  const staleCancelled = addTodo({ title: "stale cancelled", notes: "" }); deleteTodo(staleCancelled.id);
  const freshDone = addTodo({ title: "fresh done", notes: "" }); completeTodo(freshDone.id);
  const open = addTodo({ title: "open", notes: "" });
  const st = loadStore();
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
  for (const t of st.todos) {
    if (t.id === staleDone.id || t.id === staleCancelled.id) { t.closedAt = thirtyAgo; t.updatedAt = thirtyAgo; }
  }
  saveStore(st);
  const res = autoPruneOnSessionStart();
  ok("ap: returns result when something moved", res !== null);
  eq("ap: moved 2", res!.moved, 2);
  ok("ap: rich items present", res!.items.length === 2);
  ok("ap: stale done moved to archive", loadArchive().todos.some((t) => t.id === staleDone.id));
  ok("ap: stale cancelled moved to archive", loadArchive().todos.some((t) => t.id === staleCancelled.id));
  const live = loadStore();
  ok("ap: fresh done stays in live", live.todos.some((t) => t.id === freshDone.id));
  ok("ap: open untouched", live.todos.some((t) => t.id === open.id));
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// Case 2: nothing stale → null, no-op
{
  const dir = seed(mkdtempSync(join(tmpdir(), "armory-ap2-")));
  const { addTodo, completeTodo, loadStore, saveStore } = await import("../src/todo-store.ts");
  const d = addTodo({ title: "fresh done today", notes: "" }); completeTodo(d.id);
  const st = loadStore();
  const t = st.todos.find((x) => x.id === d.id)!;
  t.closedAt = new Date().toISOString();
  saveStore(st);
  const res = autoPruneOnSessionStart();
  eq("ap: null when nothing stale", res, null);
  ok("ap: live unchanged when no-op", loadStore().todos.length === 1);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// Case 3: idempotent — second call is a no-op (already pruned)
{
  const dir = seed(mkdtempSync(join(tmpdir(), "armory-ap3-")));
  const { addTodo, completeTodo, loadStore, saveStore } = await import("../src/todo-store.ts");
  const d = addTodo({ title: "stale", notes: "" }); completeTodo(d.id);
  const st = loadStore();
  const t = st.todos.find((x) => x.id === d.id)!;
  t.closedAt = new Date(Date.now() - 30 * 86400_000).toISOString();
  saveStore(st);
  const first = autoPruneOnSessionStart();
  eq("ap: first moved 1", first!.moved, 1);
  const second = autoPruneOnSessionStart();
  eq("ap: second is null (idempotent)", second, null);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// Case 4: respects config defaultAgeDays (set to 1d; a 3d-old done prunes)
{
  const dir = seed(mkdtempSync(join(tmpdir(), "armory-ap4-")));
  const { addTodo, completeTodo, loadStore, saveStore } = await import("../src/todo-store.ts");
  const { loadConfig, saveConfig } = await import("../src/config.ts");
  const cfg = loadConfig(); cfg.prune.defaultAgeDays = 1; saveConfig(cfg);
  const d = addTodo({ title: "3d done", notes: "" }); completeTodo(d.id);
  const st = loadStore();
  const t = st.todos.find((x) => x.id === d.id)!;
  t.closedAt = new Date(Date.now() - 3 * 86400_000).toISOString();
  saveStore(st);
  const res = autoPruneOnSessionStart();
  eq("ap: 3d-old prunes when ageDays=1", res!.moved, 1);
  // restore default
  cfg.prune.defaultAgeDays = 7; saveConfig(cfg);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);