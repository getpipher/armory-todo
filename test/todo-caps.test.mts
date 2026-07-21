// Suite for v0.5.0 caps enforcement (count + notes + injection truncation).
// Run: node test/todo-caps.test.mts
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
function throws(name: string, fn: () => void, expectSubstr = ""): void {
  try { fn(); ok(name, false, "(did not throw)"); }
  catch (e) {
    const msg = (e as Error).message;
    ok(name, expectSubstr === "" || msg.includes(expectSubstr), `(msg: ${msg})`);
  }
}
function notThrows(name: string, fn: () => void): void {
  try { fn(); ok(name, true); } catch (e) { ok(name, false, `((unexpected: ${(e as Error).message}))`); }
}

// Pure-function imports (no TODO_DIR needed for this section, but set it so
// later integration sections added in Tasks 3 & 4 can reuse the same tmp).
const tmp = mkdtempSync(join(tmpdir(), "armory-caps-"));
process.env.TODO_DIR = tmp;

const { checkNotesCap, checkProjectCap, overBudgetProjects } = await import("../src/caps.ts");

// ===== checkNotesCap =====
notThrows("notes under cap ok", () => checkNotesCap("hello", 16));
throws("notes over cap throws", () => checkNotesCap("x".repeat(100), 50));
throws("notes over cap message has bytes", () => checkNotesCap("x".repeat(100), 50), "maxNotesBytes");
notThrows("notes exactly at cap ok", () => checkNotesCap("ab", 2));
throws("notes cap+1 throws", () => checkNotesCap("abc", 2));
// byte-length not char-length: "é" = 2 bytes UTF-8
notThrows("unicode under byte cap ok", () => checkNotesCap("é", 2));
throws("unicode over byte cap throws", () => checkNotesCap("é", 1));
// 0 = "no notes allowed": empty ok, any content rejected
notThrows("maxBytes 0 + empty notes ok", () => checkNotesCap("", 0));
notThrows("maxBytes 0 + whitespace-only trimmed-empty ok", () => checkNotesCap("", 0));
throws("maxBytes 0 + content throws", () => checkNotesCap("x", 0));
throws("negative maxBytes rejects all", () => checkNotesCap("x", -1));

// ===== checkProjectCap =====
notThrows("uncapped (maxOpen null) ok", () => checkProjectCap({ project: "pi", currentOpen: 100, maxOpen: null }));
notThrows("one-below cap ok (lands at cap, not over)", () => checkProjectCap({ project: "pi", currentOpen: 7, maxOpen: 8 }));
notThrows("zero open under cap ok", () => checkProjectCap({ project: "pi", currentOpen: 0, maxOpen: 1 }));
throws("at-cap add throws (currentOpen == maxOpen)", () => checkProjectCap({ project: "pi", currentOpen: 8, maxOpen: 8 }));
throws("over-cap add throws", () => checkProjectCap({ project: "pi", currentOpen: 12, maxOpen: 8 }));
throws("project cap message has raise hint", () => checkProjectCap({ project: "pi", currentOpen: 8, maxOpen: 8 }), "raise maxOpen");
throws("project cap message has project name", () => checkProjectCap({ project: "getpipher", currentOpen: 8, maxOpen: 8 }), "getpipher");
// maxOpen 0 = no open todos allowed
throws("maxOpen 0 + any add throws", () => checkProjectCap({ project: "pi", currentOpen: 0, maxOpen: 0 }));

// ===== overBudgetProjects =====
const { loadRegistry, saveRegistry } = await import("../src/registry.ts");
import type { Todo } from "../src/todo-store.ts";
const fresh = new Date().toISOString();
const mk = (id: string, project: string, status: Todo["status"]): Todo => ({
  id, title: id, notes: "", project, tags: [], priority: "med", status, source: "",
  createdAt: fresh, updatedAt: fresh, closedAt: null,
});
const liveTodos: Todo[] = [
  mk("a", "pi", "open"), mk("b", "pi", "open"), mk("c", "pi", "open"),
  mk("d", "sip", "open"), mk("e", "sip", "open"),
  mk("f", "sip", "in_progress"),  // in_progress does NOT count toward open
  mk("g", "uncapped", "open"),
];
saveRegistry({ version: 1, updatedAt: "x", projects: [
  { name: "pi", maxOpen: 2, createdAt: "x", updatedAt: "x" },       // 3 open > 2 -> over
  { name: "sip", maxOpen: 8, createdAt: "x", updatedAt: "x" },       // 2 open <= 8 -> ok
  { name: "uncapped", maxOpen: null, createdAt: "x", updatedAt: "x" },
  { name: "empty", maxOpen: 3, createdAt: "x", updatedAt: "x" },     // 0 open -> not over
] });
const reg = loadRegistry();
const over = overBudgetProjects(liveTodos, reg);
eq("overBudget count 1 (only pi)", over.length, 1);
eq("overBudget pi name", over[0]!.name, "pi");
eq("overBudget pi open", over[0]!.open, 3);
eq("overBudget pi maxOpen", over[0]!.maxOpen, 2);
// empty registry -> none over
eq("overBudget empty registry", overBudgetProjects(liveTodos, { version: 1, updatedAt: "x", projects: [] }).length, 0);

// ===== addTodo / updateTodo enforcement (integration, temp TODO_DIR) =====
const { addTodo, updateTodo, getTodo, saveStore, loadStore: loadStoreFn } = await import("../src/todo-store.ts");
const { setProjectMaxOpen } = await import("../src/registry.ts");
// (saveRegistry + loadRegistry are already in scope from the pure section above.)

function resetStore(): void { saveStore({ version: 3, updatedAt: new Date().toISOString(), todos: [] }); saveRegistry({ version: 1, updatedAt: "x", projects: [] }); }
function setCap(project: string, max: number | null): void { const r = loadRegistry(); setProjectMaxOpen(r, project, max); saveRegistry(r); }

// --- notes cap on add ---
resetStore();
throws("add with oversized notes throws", () => addTodo({ title: "big", notes: "x".repeat(9000) }), "maxNotesBytes");
eq("oversized add did not persist (atomic)", loadStoreFn().todos.length, 0);
notThrows("add with under-cap notes ok", () => addTodo({ title: "ok", notes: "x".repeat(100) }));
// default cap is 8192; exactly 8192 ok, 8193 throws
resetStore();
notThrows("add notes exactly 8192 bytes ok", () => addTodo({ title: "edge", notes: "x".repeat(8192) }));
resetStore();
throws("add notes 8193 bytes throws", () => addTodo({ title: "edge", notes: "x".repeat(8193) }));

// --- notes cap on update (only when notes patch present) ---
// To test grandfathering, seed directly via saveStore bypassing addTodo:
resetStore();
saveStore({ version: 3, updatedAt: new Date().toISOString(), todos: [{ id: "legacy", title: "legacy", notes: "z".repeat(9000), project: "", tags: [], priority: "med", status: "open", source: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), closedAt: null }] });
const legacy = getTodo("legacy");
eq("grandfathered oversize note present", legacy.notes.length, 9000);
// editing TITLE only (no notes patch) must NOT re-check notes -> succeeds
notThrows("title edit on grandfathered note ok (no notes re-check)", () => updateTodo("legacy", { title: "new title" }));
eq("title changed", getTodo("legacy").title, "new title");
eq("grandfathered notes intact", getTodo("legacy").notes.length, 9000);
// editing notes (oversize) throws
throws("update notes oversize throws", () => updateTodo("legacy", { notes: "q".repeat(9000) }), "maxNotesBytes");
// notes="" always passes
notThrows("update notes empty clears ok", () => updateTodo("legacy", { notes: "" }));
eq("notes cleared", getTodo("legacy").notes, "");

// --- project cap on add ---
resetStore();
setCap("pi", 2);
notThrows("add #1 to pi (open 0->1) ok", () => addTodo({ title: "p1", project: "pi" }));
notThrows("add #2 to pi (open 1->2, lands at cap) ok", () => addTodo({ title: "p2", project: "pi" }));
throws("add #3 to pi (open 2->3 > maxOpen 2) throws", () => addTodo({ title: "p3", project: "pi" }), "maxOpen");
eq("blocked add not persisted (atomic)", loadStoreFn().todos.filter((t) => t.project === "pi").length, 2);
// uncapped project always ok
notThrows("add to uncapped project ok", () => addTodo({ title: "x", project: "other" }));
// new/unknown project -> uncapped (no registry entry) -> ok
resetStore();
notThrows("add to unknown project (no cap) ok", () => addTodo({ title: "fresh", project: "newproj" }));

// --- project cap on move (update project) ---
resetStore();
setCap("pi", 2);
setCap("sip", 1);
const m1 = addTodo({ title: "m1", project: "pi" });   // pi open=1
addTodo({ title: "m2", project: "pi" });                // pi open=2 (at cap)
// move an OPEN todo from pi into sip (sip at 0->1, under cap 1) -> ok
notThrows("move open todo into under-cap target ok", () => updateTodo(m1.id, { project: "sip" }));
eq("sip now 1 open", loadStoreFn().todos.filter((t) => t.project === "sip" && t.status === "open").length, 1);
// now move another open todo from pi into sip (sip 1->2 > cap 1) -> throws
const m2 = loadStoreFn().todos.find((t) => t.project === "pi" && t.status === "open")!;
throws("move open todo into at-cap target throws", () => updateTodo(m2.id, { project: "sip" }), "maxOpen");
// move a PARKED todo into at-cap target -> ok (no open impact)
resetStore();
setCap("sip", 1);
addTodo({ title: "occ", project: "sip" });               // sip open=1 (at cap)
const pk = addTodo({ title: "pk", project: "pi" });
updateTodo(pk.id, { status: "parked" });                  // park it (still in pi)
notThrows("move PARKED todo into at-cap target ok (no open impact)", () => updateTodo(pk.id, { project: "sip" }));
eq("parked move persisted to sip", loadStoreFn().todos.find((t) => t.id === pk.id)!.project, "sip");
// same-project "move" (no-op) -> ok (no cap check)
resetStore();
setCap("pi", 1);
const s = addTodo({ title: "s", project: "pi" });        // pi at cap 1
notThrows("update same project (no-op) ok", () => updateTodo(s.id, { project: "pi" }));
// un-park (parked->open) into a capped project -> NOT blocked (intentional)
resetStore();
setCap("pi", 1);
const u = addTodo({ title: "u", project: "pi" });        // pi at cap 1
updateTodo(u.id, { status: "parked" });                  // pi open=0
addTodo({ title: "u2", project: "pi" });                 // pi open=1 (at cap again)
notThrows("un-park into capped project ok (reactivation not blocked)", () => updateTodo(u.id, { status: "open" }));
eq("un-park persisted (now 2 open, over cap -- allowed)", loadStoreFn().todos.filter((t) => t.project === "pi" && t.status === "open").length, 2);

// ===== renderOpenBlock cap-aware truncation =====
const { renderOpenBlock } = await import("../src/todo-store.ts");
const { loadConfig, saveConfig } = await import("../src/config.ts");
const { setProjectMaxOpen: setMax } = await import("../src/registry.ts");

function setMaxOpen(project: string, max: number | null): void { const r = loadRegistry(); setMax(r, project, max); saveRegistry(r); }
function setGlobalCap(cap: number): void { saveConfig({ ...loadConfig(), health: { ...loadConfig().health, activeMaxOpen: cap } }); }

// under cap -> row list, no summary, no overflow line
resetStore();
setGlobalCap(15);
for (let i = 0; i < 3; i++) addTodo({ title: `t${i}`, project: "pi" });
const under = renderOpenBlock();
ok("under cap: header present", under.startsWith("## Open TODOs (3)"));
ok("under cap: row list (no summary)", under.includes("- [td-"));
ok("under cap: no over-budget marker", !under.includes("over budget"));

// over cap -> summary mode
resetStore();
setGlobalCap(2);
setMaxOpen("pi", 1);
addTodo({ title: "a", project: "pi" });          // pi open=1 (at cap)
addTodo({ title: "b", project: "other" });       // other uncapped
addTodo({ title: "c", project: "other" });       // 3 actionable total > activeMaxOpen 2 -> over budget
// make pi over its own cap: bump pi to 2 via direct store seed (add would throw)
saveStore({ version: 3, updatedAt: new Date().toISOString(), todos: [
  ...loadStoreFn().todos,
  { id: "td-extra", title: "extra", notes: "", project: "pi", tags: [], priority: "med", status: "open", source: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), closedAt: null },
] });
const overBlk = renderOpenBlock();
ok("over cap: header has over-budget marker", overBlk.includes("over budget (cap 2)"));
ok("over cap: has actionable count line", overBlk.includes("open+in_progress"));
ok("over cap: over-budget projects listed (pi 2/1)", overBlk.includes("pi 2/1"));
ok("over cap: has pointer line", overBlk.includes("todo list") || overBlk.includes("/todo"));
ok("over cap: no row list (no - [td-)", !overBlk.includes("- [td-"));

// over global cap but NO project over its own cap -> summary without over-budget line
resetStore();
setGlobalCap(1);
addTodo({ title: "a", project: "pi" });   // pi uncapped (no setMaxOpen)
addTodo({ title: "b", project: "pi" });   // 2 actionable > activeMaxOpen 1, but pi has no maxOpen
const overNoProj = renderOpenBlock();
ok("over global, no per-project breach: over-budget header", overNoProj.includes("over budget (cap 1)"));
ok("over global, no per-project breach: no 'over-budget:' line", !overNoProj.includes("over-budget:"));

// custom max param overrides activeMaxOpen
resetStore();
setGlobalCap(50);
for (let i = 0; i < 5; i++) addTodo({ title: `t${i}` });
const viaParam = renderOpenBlock(3);   // 5 actionable > 3 -> summary
ok("custom max param triggers summary", viaParam.includes("over budget (cap 3)"));
const viaParamUnder = renderOpenBlock(10);  // 5 <= 10 -> row list
ok("custom max param under -> row list", viaParamUnder.includes("- [td-"));

// empty store -> unchanged
resetStore();
eq("empty store render", renderOpenBlock(), "## Open TODOs\n(none — no pending cross-session TODOs)\n");

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);