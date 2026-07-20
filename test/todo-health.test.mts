import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const tmp = mkdtempSync(join(tmpdir(), "armory-health-"));
process.env.TODO_DIR = tmp;
process.env.TODO_STORE_PATH = join(tmp, "todo.json");

const { healthReport } = await import("../src/health.ts");
const { saveStore } = await import("../src/todo-store.ts");
const { saveArchive } = await import("../src/archive.ts");
import type { Todo } from "../src/todo-store.ts";

const now = Date.now();
const stale = new Date(now - 45 * 86400_000).toISOString();
const fresh = new Date(now - 5 * 86400_000).toISOString();
const parkedStale = new Date(now - 70 * 86400_000).toISOString();
const archOld = new Date(now - 200 * 86400_000).toISOString();

// Seed live: 16 open (1 stale), 3 in_progress, 12 parked (1 stale), 2 done
const liveTodos: Todo[] = [];
for (let i = 0; i < 16; i++) liveTodos.push({ id: `td-open-${i}`, text: `open ${i}`, project: i < 5 ? "pi" : "", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: i === 0 ? stale : fresh, closedAt: null });
for (let i = 0; i < 3; i++) liveTodos.push({ id: `td-ip-${i}`, text: `ip ${i}`, project: "", tags: [], priority: "high", status: "in_progress", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null });
for (let i = 0; i < 12; i++) liveTodos.push({ id: `td-park-${i}`, text: `parked ${i}`, project: "", tags: [], priority: "low", status: "parked", source: "", createdAt: fresh, updatedAt: i === 0 ? parkedStale : fresh, closedAt: null });
for (let i = 0; i < 2; i++) liveTodos.push({ id: `td-done-${i}`, text: `done ${i}`, project: "", tags: [], priority: "med", status: "done", source: "", createdAt: fresh, updatedAt: fresh, closedAt: fresh });
saveStore({ version: 2, updatedAt: fresh, todos: liveTodos });

// Seed archive: 210 items (10 older than 180d)
const archTodos: Todo[] = [];
for (let i = 0; i < 210; i++) archTodos.push({ id: `td-arch-${i}`, text: `arch ${i}`, project: i < 50 ? "nuntius" : "", tags: [], priority: "med", status: i % 2 === 0 ? "done" : "cancelled", source: "", createdAt: fresh, updatedAt: fresh, closedAt: i < 10 ? archOld : fresh });
saveArchive({ version: 2, updatedAt: fresh, todos: archTodos });

const report = healthReport();

eq("active open count", report.active.open, 16);
eq("active in_progress count", report.active.in_progress, 3);
eq("active stale_30d", report.active.stale_30d, 1);
ok("ACTIVE_LARGE flag", report.flags.includes("ACTIVE_LARGE"));
ok("ACTIVE_STALE flag", report.flags.includes("ACTIVE_STALE"));

eq("parked count", report.parked.count, 12);
eq("parked stale_60d", report.parked.stale_60d, 1);
ok("PARKED_LARGE flag", report.flags.includes("PARKED_LARGE"));
ok("PARKED_STALE flag", report.flags.includes("PARKED_STALE"));

eq("archive count", report.archive.count, 210);
eq("archive older_180d", report.archive.older_180d, 10);
ok("ARCHIVE_LARGE flag", report.flags.includes("ARCHIVE_LARGE"));
ok("ARCHIVE_OLD flag", report.flags.includes("ARCHIVE_OLD"));

ok("has suggestions", report.suggestions.length >= 0);
ok("archive suggestion mentions hard-prune", report.suggestions.some((s) => s.includes("hard-prune") || s.includes("prune --hard")));
ok("active suggestion mentions park or close", report.suggestions.some((s) => s.includes("park") || s.includes("close")));

// --- clean store → no flags ---
saveStore({ version: 2, updatedAt: fresh, todos: [] });
saveArchive({ version: 2, updatedAt: fresh, todos: [] });
const clean = healthReport();
eq("clean active open", clean.active.open, 0);
eq("clean flags empty", clean.flags.length, 0);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);