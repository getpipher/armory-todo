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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);