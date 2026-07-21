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

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);