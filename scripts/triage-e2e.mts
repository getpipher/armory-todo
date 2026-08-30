// E2E: /todo triage against a FIXTURE store, driving the real extension handler.
// Run: TODO_DIR=<tmp> TODO_TRIAGE_SKIP_FILING=1 tsx scripts/triage-e2e.mts
// NEVER run against the live store — the TODO_DIR below is explicit.

import { rmSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const TMP = "/tmp/armory-todo-triage-e2e";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
process.env.TODO_DIR = TMP;
process.env.TODO_TRIAGE_SKIP_FILING = "1"; // hermetic: no gh in this leg

const { addTodo, loadStore, saveStore, getTodo } = await import("../src/todo-store.ts");
const { loadArchive } = await import("../src/archive.ts");
const { loadRegistry, saveRegistry, setProjectMaxOpen } = await import("../src/registry.ts");
const mod = await import("../extensions/todo.ts");

const DAY = 86_400_000;
function backdate(id: string, days: number) {
  const s = loadStore();
  const row = s.todos.find((t) => t.id === id)!;
  row.updatedAt = new Date(Date.now() - days * DAY).toISOString();
  row.createdAt = row.updatedAt;
  saveStore(s);
}

// --- fixture store (NOT the live store) ------------------------------------
const debris = addTodo({ title: "You are implementing Task 9: E2E legs, scripts, README, full graduation gate — final task of sub-plan", project: "fleet" }).id;
backdate(debris, 20);
const stale = addTodo({ title: "core Dependabot sweep (11 vulns)", project: "core" }).id;
backdate(stale, 45);
const overcapA = addTodo({ title: "SPEC-3 follow-up: image attach-to-send", project: "nuntius" }).id;
backdate(overcapA, 3);
const overcapB = addTodo({ title: "decommission old Neon project", project: "nuntius" }).id;
backdate(overcapB, 2);
const reg = loadRegistry();
setProjectMaxOpen(reg, "nuntius", 1);
saveRegistry(reg);

// --- mock the pi extension API, capture the registered tool ----------------
const tools: Record<string, any> = {};
const commands: Record<string, any> = {};
mod.default({
  on: () => {},
  registerTool: (t: any) => (tools[t.name] = t),
  registerCommand: (n: string, c: any) => (commands[n] = c),
} as any);
const todo = tools["todo"];
assert.ok(todo, "todo tool registered");

const activeCount = () => loadStore().todos.filter((t) => t.status === "open" || t.status === "in_progress").length;
const before = activeCount();

// --- phase 1: gather + propose (NOTHING mutated) ---------------------------
const phase1 = await todo.execute("e2e", { action: "triage" });
const p1 = phase1.content[0].text;
assert.match(p1, /NOTHING mutated yet/);
assert.match(p1, /triage-rubric\/v1/);
assert.ok(p1.includes(debris));
assert.ok(p1.includes(stale));
assert.match(p1, /over-cap-project/);
assert.match(p1, / You are implementing/); // safe-class marker row
assert.equal(activeCount(), before, "phase 1 must not mutate");
console.log("PHASE 1 OK — proposal table + rubric, store untouched");
console.log(p1.split("\n").slice(0, 12).join("\n"), "...\n");

// --- --yes: safe class only -------------------------------------------------
const yesRun = await todo.execute("e2e", { action: "triage", autoSafe: true });
const pYes = yesRun.content[0].text;
assert.match(pYes, /safe class ONLY/);
assert.throws(() => getTodo(debris), /no todo with id/, "debris auto-closed");
assert.equal(loadArchive().todos.find((t) => t.id === debris)?.status, "cancelled");
assert.equal(getTodo(stale).status, "open", "unverified items NEVER auto-closed");
assert.equal(getTodo(overcapA).status, "open");
console.log("--YES OK — mechanical debris closed + archived; human items untouched");

// --- phase 2: batch approval ------------------------------------------------
const approveRun = await todo.execute("e2e", {
  action: "triage",
  approve: [
    { id: stale, verdict: "close", reason: "verified-shipped", evidence: "dependabot alerts resolved; pnpm audit clean", confidence: "high" },
    { id: overcapA, verdict: "park", confidence: "medium" },
    { id: overcapB, verdict: "keep" },
  ],
});
const p2 = approveRun.content[0].text;
console.log("PHASE 2 report:\n" + p2 + "\n");
assert.match(p2, /closed \(1\)/);
assert.match(p2, /parked \(1\)/);
assert.match(p2, /kept \(1\)/);
assert.equal(loadArchive().todos.find((t) => t.id === stale)?.status, "cancelled");
assert.equal(getTodo(overcapA).status, "parked");
assert.equal(getTodo(overcapB).status, "open");
assert.match(p2, /ledger: not filed/, "skip-filing leg reports unbuilt ledger plainly");

// --- D2 negative: the tool must reject unapproved shapes --------------------
const bad = await todo.execute("e2e", { action: "triage", approve: [{ id: overcapB, verdict: "close" }] });
assert.match(bad.content[0].text, /close requires reason/);
assert.equal(getTodo(overcapB).status, "open", "malformed decision mutates nothing");

console.log(`E2E GREEN — before ${before} active → after ${activeCount()} active / ${loadStore().todos.filter((t) => t.status === "parked").length} parked / ${loadArchive().todos.length} archived`);
rmSync(TMP, { recursive: true, force: true });
