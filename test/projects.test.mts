import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = ""): void { if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); } }
function eq<T>(name: string, got: T, want: T): void { ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`); }

const tmp = mkdtempSync(join(tmpdir(), "armory-proj-"));
process.env.TODO_DIR = tmp;

const { projectsOverview } = await import("../src/projects.ts");
const { addTodo, updateTodo, completeTodo } = await import("../src/todo-store.ts");
const { saveArchive } = await import("../src/archive.ts");
const { setProjectMaxOpen, loadRegistry, saveRegistry } = await import("../src/registry.ts");
import type { ArchiveStore } from "../src/archive.ts";

// --- empty store → empty overview ---
const o0 = projectsOverview();
eq("empty rows", o0.rows.length, 0);
eq("empty totalTodos", o0.totalTodos, 0);
eq("empty noProject count", o0.noProject.count, 0);

// --- counts across live + archived done ---
const a = addTodo({ title: "a", project: "pi" });
addTodo({ title: "b", project: "pi" });
const c = addTodo({ title: "c", project: "pi" });
updateTodo(c.id, { status: "in_progress" });
const d = addTodo({ title: "d", project: "pi" });
completeTodo(d.id);                    // live done
addTodo({ title: "e", project: "sip" });   // open, separate project
addTodo({ title: "f", project: "" });      // (no project)

// archived done for "pi" (synthetic copy; tests live-done + archived-done aggregation)
const arch: ArchiveStore = { version: 3, updatedAt: "x", todos: [{ ...d, project: "pi", status: "done", closedAt: "2026-07-01T00:00:00.000Z" }] };
saveArchive(arch);

const o1 = projectsOverview();
const pi = o1.rows.find((r) => r.name === "pi")!;
const sip = o1.rows.find((r) => r.name === "sip")!;
eq("pi open", pi.open, 2);
eq("pi in_progress", pi.in_progress, 1);
eq("pi parked", pi.parked, 0);
eq("pi done (live done + archived done)", pi.done, 1 + 1);
eq("pi total", pi.total, 5);
eq("sip open", sip.open, 1);
eq("noProject count", o1.noProject.count, 1);
eq("noProject open", o1.noProject.open, 1);

// --- sort: open desc → total desc → name asc ---
addTodo({ title: "g", project: "alpha" });
addTodo({ title: "h", project: "alpha" });   // alpha: 2 open
const o2 = projectsOverview();
eq("first row is pi (open 2, total 5 > alpha total 2)", o2.rows[0]!.name, "pi");
ok("sort produces ≥3 rows", o2.rows.length >= 3);

// --- maxOpen + over flag ---
let reg = loadRegistry();
setProjectMaxOpen(reg, "sip", 0);   // maxOpen 0 → any open is over
saveRegistry(reg);
const o3 = projectsOverview();
const sip3 = o3.rows.find((r) => r.name === "sip")!;
eq("sip maxOpen 0", sip3.maxOpen, 0);
ok("sip over (1 > 0)", sip3.over);

// --- typo: 1-todo project with near-sibling; 2-todo project is not typo ---
addTodo({ title: "z", project: "foo-bat" });   // 1 todo
addTodo({ title: "y", project: "foo-bar" });    // 1 todo, near foo-bat (symmetric)
addTodo({ title: "s1", project: "solo-proj" });
addTodo({ title: "s2", project: "solo-proj" });    // 2 todos → not typo
const o4 = projectsOverview();
ok("foo-bat typo (near foo-bar)", o4.rows.find((r) => r.name === "foo-bat")!.typo);
ok("foo-bat typo (near foo-bat, symmetric)", o4.rows.find((r) => r.name === "foo-bar")!.typo);
ok("solo-proj not typo (2 todos)", !o4.rows.find((r) => r.name === "solo-proj")!.typo);

// --- lastUpdated = max live updatedAt, "" if no live todos ---
const o5 = projectsOverview();
ok("pi lastUpdated non-empty", o5.rows.find((r) => r.name === "pi")!.lastUpdated.length > 0);

// --- registry seeded via reconcile (projectsOverview persists) ---
ok("registry has foo-bat", loadRegistry().projects.some((p) => p.name === "foo-bat"));
ok("registry has solo-proj", loadRegistry().projects.some((p) => p.name === "solo-proj"));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);