// E2E: the v0.8.0 panel Triage tab, driven HEADLESS (real TodoPanel class,
// mocked theme — no terminal) against a FIXTURE store.
// Run: TODO_DIR=<tmp> TODO_TRIAGE_SKIP_FILING=1 tsx scripts/triage-panel-e2e.mts
// NEVER run against the live store.

import { rmSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const TMP = "/tmp/armory-todo-triage-panel-e2e";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
process.env.TODO_DIR = TMP;
process.env.TODO_TRIAGE_SKIP_FILING = "1"; // hermetic: no gh in this leg

const { addTodo, loadStore, saveStore, getTodo } = await import("../src/todo-store.ts");
const { loadArchive } = await import("../src/archive.ts");
const mod = await import("../src/panel.ts");
const { TodoPanel } = mod;

const DAY = 86_400_000;
function backdate(id: string, days: number) {
  const s = loadStore();
  const row = s.todos.find((t) => t.id === id)!;
  row.updatedAt = new Date(Date.now() - days * DAY).toISOString();
  row.createdAt = row.updatedAt;
  saveStore(s);
}

// --- fixture store ----------------------------------------------------------
const debris = addTodo({ title: "You are implementing Task 9: E2E legs, scripts, README, full graduation gate", project: "fleet" }).id;
backdate(debris, 20);
const stale = addTodo({ title: "core Dependabot sweep (11 vulns)", project: "core" }).id;
backdate(stale, 45);

// --- panel with a mocked theme ---------------------------------------------
const theme: any = { fg: (_k: string, s: string) => s, bold: (s: string) => s };
const notes: string[] = [];
const panel = new TodoPanel({
  theme,
  onDone: () => notes.push("__done__"),
  onNotify: (msg) => notes.push(msg),
});
const render = (): string => (panel as any).render(120).join("\n");

// --- reach the Triage tab (5 tabs from active) ------------------------------
for (let i = 0; i < 5; i++) panel.handleInput("\t");
let out = render();
assert.match(out, /\[triage\]/, "triage tab is active");
assert.match(out, /CLOSE·debris/, "safe debris pre-chipped to close");
assert.match(out, /⚡/, "safe marker visible");
assert.match(out, /keep.*stale-30d|stale-30d.*keep/, "stale row defaults to keep");
assert.equal(getTodo(debris).status, "open", "rendering mutates nothing");

// --- D2: one A arms, NOTHING mutates ---------------------------------------
panel.handleInput("A");
out = render();
assert.match(out, /ARMED/, "arm bar shows");
assert.match(out, /1 close \/ 0 park \/ 1 keep/, "batch summary counts");
assert.equal(getTodo(debris).status, "open", "armed but not executed");

// esc disarms (and does NOT close the panel)
panel.handleInput("\x1b");
out = render();
assert.ok(!out.includes("ARMED"), "esc disarms");
assert.ok(!notes.includes("__done__"), "esc while armed does not close the panel");
assert.equal(getTodo(debris).status, "open", "disarm mutates nothing");

// --- override the stale row to PARK via the action path ---------------------
(panel as any).openTriageSubmenu(stale);
out = render();
assert.match(out, /Verdict: PARK/, "submenu lists verdict actions");
(panel as any).executeTriageRowAction(stale, "v:park");
out = render();
assert.match(out, /PARK/, "stale row now chipped PARK");
assert.equal(getTodo(stale).status, "open", "chip is a proposal — not yet applied");

// arm changed since the last batch — arm again, then execute
panel.handleInput("A");
panel.handleInput("A");
// NOTE: executeTriage's mutation phase is synchronous (the first await is in
// ledger filing) — closures/parks land immediately; only the completion notify
// is async.
assert.throws(() => getTodo(debris), /no todo with id/, "debris closed");
assert.equal(loadArchive().todos.find((t) => t.id === debris)?.status, "cancelled", "and archived");
assert.equal(getTodo(stale).status, "parked", "stale row parked");

// let the async completion (report + re-gather) settle
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));

assert.ok(notes.some((n) => /Triage executed: 1 closed, 1 parked/.test(n)), `completion reported, got: ${JSON.stringify(notes)}`);
assert.ok(notes.some((n) => /filed 0/.test(n)), "skip-filing leg reported plainly");

// rows re-gathered after execution: both executed rows are gone
out = render();
assert.ok(!out.includes(debris), "closed row left the tab");
assert.ok(!out.includes(stale), "parked row left the tab");

console.log("PANEL E2E GREEN — chips, D2 arm/disarm, batch execute, archive + park verified");
rmSync(TMP, { recursive: true, force: true });
