let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

const { todoToItem, archiveSummaryToItems, actionsForTodo, configToSettingItems } = await import("../src/panel-data.ts");
import type { Todo } from "../src/todo-store.ts";

const t: Todo = { id: "td-x1", title: "ship the thing", notes: "", project: "nuntius", tags: ["mcp"], priority: "critical", status: "open", source: "", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z", closedAt: null };

// todoToItem
const item = todoToItem(t);
eq("item value is id", item.value, "td-x1");
ok("item label has priority", item.label.includes("critical"));
ok("item label has title", item.label.includes("ship the thing"));
ok("item label has project", item.label.includes("nuntius"));
ok("item label has no • when notes empty", !item.label.includes("•"));

// todoToItem: • when notes present; title shown, notes content not shown
const withNotes: Todo = { ...t, id: "td-x2", title: "has detail", notes: "lots of context", status: "in_progress" };
const itemNotes = todoToItem(withNotes);
ok("item label has • when notes present", itemNotes.label.includes("•"));
ok("item label has title not notes content", itemNotes.label.includes("has detail") && !itemNotes.label.includes("lots of context"));
ok("item label has in_progress pin", itemNotes.label.includes("⏵"));

// actionsForTodo — open todo
const openActions = actionsForTodo({ ...t, status: "open" });
ok("open has complete", openActions.some((a) => a.action === "complete"));
ok("open has park", openActions.some((a) => a.action === "park"));
ok("open has edit", openActions.some((a) => a.action === "edit"));
ok("open has delete", openActions.some((a) => a.action === "delete"));
ok("open no restore", !openActions.some((a) => a.action === "restore"));
ok("edit label is 'Edit title' (renamed)", openActions.some((a) => a.label === "Edit title" && a.action === "edit"));
ok("no 'Edit text' label (renamed)", !openActions.some((a) => a.label === "Edit text"));

// parked todo
const parkedActions = actionsForTodo({ ...t, status: "parked" });
ok("parked has open", parkedActions.some((a) => a.action === "open"));
ok("parked has complete", parkedActions.some((a) => a.action === "complete"));

// done todo
const doneActions = actionsForTodo({ ...t, status: "done" });
ok("done has restore", doneActions.some((a) => a.action === "restore"));

// archiveSummaryToItems
const summaryItems = archiveSummaryToItems({ total: 5, byProject: { nuntius: 3, "(none)": 2 }, byMonth: { "2026-07": 4, "2026-06": 1 } });
ok("summary has total item", summaryItems.some((i) => i.label.includes("Total")));
ok("summary has project items", summaryItems.some((i) => i.label.includes("nuntius")));
ok("summary has month items", summaryItems.some((i) => i.label.includes("2026-07")));

// configToSettingItems
const { DEFAULT_CONFIG } = await import("../src/config.ts");
const settings = configToSettingItems(DEFAULT_CONFIG);
ok("settings has defaultAgeDays", settings.some((s) => s.id === "defaultAgeDays"));
ok("settings has activeMaxOpen", settings.some((s) => s.id === "activeMaxOpen"));
ok("settings has archiveOldDays", settings.some((s) => s.id === "archiveOldDays"));



// --- todoDoneItem: location-tagged label + actionsForDoneTodo ---
const { todoDoneItem, actionsForDoneTodo } = await import("../src/panel-data.ts");
import type { DoneItem } from "../src/archive.ts";

const liveDone: DoneItem = { id: "td-d1", title: "finished today", notes: "", project: "pi", tags: [], priority: "med", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: new Date().toISOString(), location: "live", archivedAt: null };
const archDone: DoneItem = { id: "td-d2", title: "old finished", notes: "", project: "", tags: [], priority: "low", status: "done", source: "", createdAt: "x", updatedAt: "x", closedAt: "2026-07-10T00:00:00Z", location: "archive", archivedAt: "2026-07-10T00:00:00Z" };

const li = todoDoneItem(liveDone);
ok("doneItem: label has title", li.label.includes("finished today"));
ok("doneItem: live tagged [live Nd]", /\[live \d+d\]/.test(li.label));

const ai = todoDoneItem(archDone);
ok("doneItem: archive tagged [archived YYYY-MM-DD]", ai.label.includes("[archived 2026-07-10]"));

ok("done actions: View detail (live)", actionsForDoneTodo(liveDone).some((a) => a.action === "view"));
ok("done actions: no Restore for live", !actionsForDoneTodo(liveDone).some((a) => a.action === "restore"));
ok("done actions: Restore for archived", actionsForDoneTodo(archDone).some((a) => a.action === "restore"));
ok("done actions: no Delete for done", !actionsForDoneTodo(liveDone).some((a) => a.action === "delete"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);