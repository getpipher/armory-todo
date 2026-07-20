import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}

const { migrateIfNeeded } = await import("../src/migrate.ts");

// --- Case 1: legacy file exists, folder doesn't → migrate ---
{
  const todoDir = mkdtempSync(join(tmpdir(), "armory-mig1-"));
  const legacy = join(todoDir, "legacy-todo.json");
  writeFileSync(legacy, JSON.stringify({ version: 1, updatedAt: "2026-06-23T10:00:00Z", todos: [{ id: "td-x", text: "old", project: "", tags: [], priority: "med", status: "done", source: "", createdAt: "2026-06-23T10:00:00Z", updatedAt: "2026-06-23T10:00:00Z", closedAt: "2026-06-23T10:00:00Z" }] }, null, 2), "utf8");
  const targetDir = join(todoDir, "todo");
  migrateIfNeeded({ todoDir: targetDir, legacyPath: legacy });
  ok("case1: todo.json moved into folder", existsSync(join(targetDir, "todo.json")));
  ok("case1: legacy file removed", !existsSync(legacy));
  const moved = JSON.parse(readFileSync(join(targetDir, "todo.json"), "utf8"));
  ok("case1: moved content preserved", moved.todos.length === 1 && moved.todos[0].id === "td-x");
  rmSync(todoDir, { recursive: true, force: true });
}

// --- Case 2: folder already exists → no-op (idempotent) ---
{
  const todoDir = mkdtempSync(join(tmpdir(), "armory-mig2-"));
  const legacy = join(todoDir, "legacy-todo.json");
  writeFileSync(legacy, '{"version":1,"todos":[]}', "utf8");
  const targetDir = join(todoDir, "todo");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "todo.json"), '{"version":2,"todos":[]}', "utf8");
  migrateIfNeeded({ todoDir: targetDir, legacyPath: legacy });
  ok("case2: legacy file untouched (no-op)", existsSync(legacy));
  ok("case2: existing todo.json untouched", JSON.parse(readFileSync(join(targetDir, "todo.json"), "utf8")).version === 2);
  rmSync(todoDir, { recursive: true, force: true });
}

// --- Case 3: neither exists → no-op (fresh install) ---
{
  const todoDir = mkdtempSync(join(tmpdir(), "armory-mig3-"));
  const legacy = join(todoDir, "nope.json"); // doesn't exist
  const targetDir = join(todoDir, "todo");
  migrateIfNeeded({ todoDir: targetDir, legacyPath: legacy });
  ok("case3: no todo.json created (no legacy to move)", !existsSync(join(targetDir, "todo.json")));
  rmSync(todoDir, { recursive: true, force: true });
}

// --- v2 → v3 migration (migrateV2ToV3) ---
const { migrateV2ToV3 } = await import("../src/migrate.ts");

// Case 4: curated — the 2 known ids get hand-written title + notes
{
  const v2 = {
    version: 2 as const,
    updatedAt: "2026-07-20T17:51:46.838Z",
    todos: [
      { id: "td-mrt3zp9fcnug3p", text: "old junk-drawer blob", project: "bug-bounty", tags: [], priority: "critical", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null },
      { id: "td-mrt4e1qi9td6jz", text: "old armory blob", project: "getpipher", tags: ["a"], priority: "high", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: "x" },
    ],
  };
  const v3 = migrateV2ToV3(v2);
  ok("v2→v3: version 3", v3.version === 3);
  ok("v2→v3: curated ZeroClaw title", v3.todos[0]!.title === "ZeroClaw×Solana bounty — Phase 4-5: demo video (score bottleneck, unstarted)");
  ok("v2→v3: curated ZeroClaw notes start with listing", v3.todos[0]!.notes.startsWith("superteam.fun/earn/listing/zeroclaw"));
  ok("v2→v3: curated armory title", v3.todos[1]!.title === "armory-todo v0.2.0 — Workstream A shipped (lifecycle boxes + prune + health + TUI)");
  ok("v2→v3: curated armory notes mention incident", v3.todos[1]!.notes.includes("INCIDENT"));
  ok("v2→v3: no text field on curated todos", !("text" in v3.todos[0]!) && !("text" in v3.todos[1]!));
  ok("v2→v3: curated preserves project", v3.todos[0]!.project === "bug-bounty" && v3.todos[1]!.project === "getpipher");
}

// Case 5: fallback — single-line text
{
  const v3 = migrateV2ToV3({ version: 2, updatedAt: "x", todos: [{ id: "td-a", text: "just a title", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] });
  ok("v2→v3 fallback single-line: title=whole", v3.todos[0]!.title === "just a title");
  ok("v2→v3 fallback single-line: notes empty", v3.todos[0]!.notes === "");
}

// Case 6: fallback — multi-line text
{
  const v3 = migrateV2ToV3({ version: 2, updatedAt: "x", todos: [{ id: "td-b", text: "the title\nline two\nline three", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] });
  ok("v2→v3 fallback multi-line: title=first line", v3.todos[0]!.title === "the title");
  ok("v2→v3 fallback multi-line: notes=rest", v3.todos[0]!.notes === "line two\nline three");
}

// Case 7: fallback — first line > 120 (truncated title, full first line preserved in notes)
{
  const longFirst = "w".repeat(200);
  const v3 = migrateV2ToV3({ version: 2, updatedAt: "x", todos: [{ id: "td-c", text: `${longFirst}\nrest of it`, project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] });
  ok("v2→v3 fallback overlong: title ≤120", v3.todos[0]!.title.length <= 120);
  ok("v2→v3 fallback overlong: notes starts with full original first line", v3.todos[0]!.notes.startsWith(longFirst));
  ok("v2→v3 fallback overlong: notes ends with rest", v3.todos[0]!.notes.endsWith("rest of it"));
}

// Case 8: persist-once — loadStore migrates a v2 file to v3 on disk
{
  const dir = mkdtempSync(join(tmpdir(), "armory-mig-v3-"));
  const file = join(dir, "todo.json");
  writeFileSync(file, JSON.stringify({ version: 2, updatedAt: "2026-07-20T10:00:00Z", todos: [{ id: "td-p", text: "persist me\nbody", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] }), "utf8");
  process.env.TODO_DIR = dir;
  const { loadStore } = await import("../src/todo-store.ts");
  const store = loadStore();
  ok("persist-once: in-memory version 3", store.version === 3);
  ok("persist-once: title derived", store.todos[0]!.title === "persist me");
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  ok("persist-once: disk version 3", onDisk.version === 3);
  ok("persist-once: disk no text field", !("text" in onDisk.todos[0]));
  ok("persist-once: second load is a no-op (version already 3)", loadStore().version === 3);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// Case 9: v2→v3 works under TODO_DIR override (no env guard needed)
{
  const dir = mkdtempSync(join(tmpdir(), "armory-mig-env-"));
  process.env.TODO_DIR = dir;
  const file = join(dir, "todo.json");
  writeFileSync(file, JSON.stringify({ version: 2, updatedAt: "x", todos: [{ id: "td-e", text: "env override ok", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: "x", updatedAt: "x", closedAt: null }] }), "utf8");
  const { loadStore } = await import("../src/todo-store.ts");
  const store = loadStore();
  ok("v2→v3 under TODO_DIR override: migrates", store.version === 3 && store.todos[0]!.title === "env override ok");
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);