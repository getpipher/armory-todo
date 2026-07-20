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

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);