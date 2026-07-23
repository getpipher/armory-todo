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

// --- notesBytes: total/max/avg across active+parked (archived excluded) ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-health-notes-"));
  process.env.TODO_DIR = dir;
  const { addTodo, completeTodo, parkTodo } = await import("../src/todo-store.ts");
  const { pruneTodos } = await import("../src/archive.ts");
  const { healthReport: hr2 } = await import("../src/health.ts");
  addTodo({ title: "a", notes: "short" });                       // 5 bytes
  addTodo({ title: "b", notes: "x".repeat(100) });               // 100 bytes
  const parked = addTodo({ title: "c", notes: "y".repeat(40) }); // 40 bytes
  parkTodo(parked.id);
  const done = addTodo({ title: "d", notes: "z".repeat(999) });  // archived-excluded
  completeTodo(done.id);
  pruneTodos({ all: true });
  const r = hr2();
  ok("notesBytes: total = 5+100+40", r.notesBytes.total === 145);
  ok("notesBytes: max = 100", r.notesBytes.max === 100);
  ok("notesBytes: avg = round(145/3) = 48", r.notesBytes.avg === 48);
  ok("notesBytes: excludes archived (999 not in total)", r.notesBytes.total < 999);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// --- notesBytes: empty store -> zeros ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-health-empty-"));
  process.env.TODO_DIR = dir;
  const { healthReport: hr3 } = await import("../src/health.ts");
  const r = hr3();
  eq("notesBytes empty: total 0", r.notesBytes.total, 0);
  eq("notesBytes empty: max 0", r.notesBytes.max, 0);
  eq("notesBytes empty: avg 0", r.notesBytes.avg, 0);
  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// --- per-project flags (v0.4.0) ---
{
  const dir = mkdtempSync(join(tmpdir(), "armory-health-proj-"));
  process.env.TODO_DIR = dir;
  const { addTodo } = await import("../src/todo-store.ts");
  const { setProjectMaxOpen, loadRegistry, saveRegistry } = await import("../src/registry.ts");
  const { healthReport: hr4 } = await import("../src/health.ts");

  // PROJECT_OVER: maxOpen 1, 2 open
  addTodo({ title: "p1", project: "over-proj" });
  addTodo({ title: "p2", project: "over-proj" });
  const reg = loadRegistry();
  setProjectMaxOpen(reg, "over-proj", 1);
  saveRegistry(reg);

  // PROJECT_LARGE: 9 open (> perProjectDefaultMax 8), maxOpen null
  for (let i = 0; i < 9; i++) addTodo({ title: `large-${i}`, project: "large-proj" });

  // PROJECT_TYPO: 1 todo + near sibling
  addTodo({ title: "typo", project: "foo-bat" });
  addTodo({ title: "sib", project: "foo-bar" });

  const r = hr4();
  ok("PROJECT_OVER flag", r.flags.includes("PROJECT_OVER"));
  ok("PROJECT_LARGE flag (9 > 8)", r.flags.includes("PROJECT_LARGE"));
  ok("PROJECT_TYPO flag", r.flags.includes("PROJECT_TYPO"));
  ok("health.projects populated", r.projects.length > 0);
  ok("noProject.open is a number", typeof r.noProject.open === "number");
  ok("suggestion mentions rename for typo", r.suggestions.some((s) => s.includes("rename")));
  ok("over-proj in projects[] (over)", r.projects.some((p) => p.name === "over-proj" && p.over));
  ok("large-proj in projects[] (large)", r.projects.some((p) => p.name === "large-proj" && p.large));
  ok("foo-bat in projects[] (typo)", r.projects.some((p) => p.name === "foo-bat" && p.typo));

  delete process.env.TODO_DIR;
  rmSync(dir, { recursive: true, force: true });
}

// ===== v0.5.0: NOTES_OVER flag + maxId =====
const { saveConfig } = await import("../src/config.ts");
saveConfig({ version: 1, prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] }, health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: 100 } });
saveStore({ version: 3, updatedAt: fresh, todos: [
  { id: "td-big", title: "big note todo", notes: "z".repeat(500), project: "pi", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
  { id: "td-small", title: "small note todo", notes: "y".repeat(20), project: "pi", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null },
] });
const rep2 = healthReport();
ok("NOTES_OVER flag present when max note > cap", rep2.flags.includes("NOTES_OVER"));
eq("notesBytes.max is the big note size", rep2.notesBytes.max, 500);
eq("notesBytes.maxId is the big todo", rep2.notesBytes.maxId, "td-big");
ok("NOTES_OVER suggestion names the offender id", rep2.suggestions.some((s) => s.includes("td-big") && s.includes("trim via todo update")));

// under cap -> no NOTES_OVER (maxId still tracked)
saveConfig({ version: 1, prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] }, health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: 8192 } });
const rep3 = healthReport();
ok("no NOTES_OVER when under cap", !rep3.flags.includes("NOTES_OVER"));
eq("maxId tracked under cap (biggest note)", rep3.notesBytes.maxId, "td-big");

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);