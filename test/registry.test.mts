import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = ""): void { if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); } }
function eq<T>(name: string, got: T, want: T): void { ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`); }

const tmp = mkdtempSync(join(tmpdir(), "armory-reg-"));
process.env.TODO_DIR = tmp;

const { loadRegistry, saveRegistry, reconcileRegistry, getProjectEntry, setProjectMaxOpen, renameProject } = await import("../src/registry.ts");
const { addTodo, listTodos } = await import("../src/todo-store.ts");
const { saveArchive, loadArchive } = await import("../src/archive.ts");
import type { ArchiveStore } from "../src/archive.ts";

// --- loadRegistry: missing → empty, no file created ---
const r0 = loadRegistry();
eq("missing registry → empty", r0.projects.length, 0);
ok("missing registry → no file yet", !existsSync(join(tmp, "projects.json")));

// --- saveRegistry: atomic + 0600 + version 1 ---
saveRegistry({ version: 1, updatedAt: "x", projects: [{ name: "pi", maxOpen: 5, createdAt: "x", updatedAt: "x" }] });
const r1 = loadRegistry();
eq("saved registry reloads name", r1.projects[0]!.name, "pi");
eq("saved registry reloads maxOpen", r1.projects[0]!.maxOpen, 5);
eq("registry version 1", r1.version, 1);
const mode = statSync(join(tmp, "projects.json")).mode & 0o777;
ok("registry file mode 0600", mode === 0o600, `(mode ${mode.toString(8)})`);

// --- reconcileRegistry: appends unknown from live + archive, idempotent ---
const a = addTodo({ title: "T1", project: "getpipher" });
const arch0: ArchiveStore = { version: 3, updatedAt: "x", todos: [{ ...a, project: "bug-bounty", status: "done", closedAt: "x" }] };
saveArchive(arch0);
let reg = loadRegistry();
const res1 = reconcileRegistry(reg, listTodos({ status: "all", limit: 200 }), arch0.todos);
ok("reconcile changed (2 new; pi pre-existing)", res1.changed && res1.reg.projects.length === 3);
const res2 = reconcileRegistry(res1.reg, listTodos({ status: "all", limit: 200 }), arch0.todos);
ok("reconcile idempotent", !res2.changed);

// --- reconcile ignores empty-string project ---
addTodo({ title: "T2", project: "" });
const res3 = reconcileRegistry(res1.reg, listTodos({ status: "all", limit: 200 }), arch0.todos);
ok("reconcile no (no project) entry", !res3.reg.projects.some((p) => p.name === ""));

// --- getProjectEntry hit/miss ---
ok("getProjectEntry hit", getProjectEntry(res3.reg, "getpipher") !== undefined);
ok("getProjectEntry miss", getProjectEntry(res3.reg, "nope") === undefined);

// --- setProjectMaxOpen: create-if-unknown, set number, null clears ---
const e1 = setProjectMaxOpen(res3.reg, "getpipher", 8);
eq("setMaxOpen sets 8", e1.maxOpen, 8);
const e2 = setProjectMaxOpen(res3.reg, "brand-new", 3);
ok("setMaxOpen creates unknown", getProjectEntry(res3.reg, "brand-new") !== undefined && e2.maxOpen === 3);
const e3 = setProjectMaxOpen(res3.reg, "getpipher", null);
eq("setMaxOpen null clears", e3.maxOpen, null);
let threw = false;
try { setProjectMaxOpen(res3.reg, "", 5); } catch { threw = true; }
ok("setMaxOpen '' throws", threw);
let threw2 = false;
try { setProjectMaxOpen(res3.reg, "x", -1); } catch { threw2 = true; }
ok("setMaxOpen negative throws", threw2);

// --- renameProject: rewrites live + archive + registry; merge; self no-op ---
// (fresh isolated registry for rename tests)
rmSync(join(tmp, "projects.json"), { force: true });
const r1a = addTodo({ title: "R1", project: "getpither" });
addTodo({ title: "R2", project: "getpither" });
const arch1: ArchiveStore = { version: 3, updatedAt: "x", todos: [{ ...r1a, project: "getpither", status: "done", closedAt: "x" }] };
saveArchive(arch1);
let regR = loadRegistry();
const syncR = reconcileRegistry(regR, listTodos({ status: "all", limit: 200 }), loadArchive().todos);
saveRegistry(syncR.reg);
// rename getpither → getpipher: getpipher already exists (from `a`) → this IS the typo-cleanup MERGE case
const rr = renameProject("getpither", "getpipher");
eq("rename liveRenamed", rr.liveRenamed, 2);
eq("rename archivedRenamed", rr.archivedRenamed, 1);
ok("typo-cleanup rename → merged=true", rr.merged);
ok("rename removed old entry", getProjectEntry(loadRegistry(), "getpither") === undefined);
ok("getpither entry present after merge", getProjectEntry(loadRegistry(), "getpipher") !== undefined);

// self-rename no-op
const self = renameProject("getpipher", "getpipher");
eq("self-rename liveRenamed 0", self.liveRenamed, 0);
eq("self-rename merged false", self.merged, false);

// rename onto existing = merge
addTodo({ title: "R3", project: "alpha" });
addTodo({ title: "R4", project: "beta" });
let regM = loadRegistry();
const syncM = reconcileRegistry(regM, listTodos({ status: "all", limit: 200 }), loadArchive().todos);
saveRegistry(syncM.reg);
const mr = renameProject("alpha", "beta");
ok("merge → merged=true", mr.merged);
ok("merge removed alpha entry", getProjectEntry(loadRegistry(), "alpha") === undefined);
ok("merge consolidated into beta", getProjectEntry(loadRegistry(), "beta") !== undefined);

// rename unknown old → throws
let threw3 = false;
try { renameProject("does-not-exist", "x"); } catch { threw3 = true; }
ok("rename unknown throws", threw3);

// --- corrupt registry → backup + fresh empty ---
writeFileSync(join(tmp, "projects.json"), "{ not json", "utf8");
const recovered = loadRegistry();
eq("corrupt registry → empty", recovered.projects.length, 0);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);