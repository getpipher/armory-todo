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

const t: Todo = { id: "td-x1", text: "ship the thing", project: "nuntius", tags: ["mcp"], priority: "critical", status: "open", source: "", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z", closedAt: null };

// todoToItem
const item = todoToItem(t);
eq("item value is id", item.value, "td-x1");
ok("item label has priority", item.label.includes("critical"));
ok("item label has text", item.label.includes("ship the thing"));
ok("item label has project", item.label.includes("nuntius"));

// todoToItem truncation — long text gets shortened with ellipsis
const longText = "This is a very long todo text that exceeds the 80 character limit and should be truncated with an ellipsis so the row stays readable in the TUI panel without blowing out the width";
const longItem = todoToItem({ ...t, text: longText });
ok("long text truncated", longItem.label.includes("…"));
ok("long text not full", !longItem.label.includes("blowing out the width"));
ok("long text has id", longItem.label.includes("td-x1"));
// short text not truncated
ok("short text not truncated", !item.label.includes("…"));

// actionsForTodo — open todo
const openActions = actionsForTodo({ ...t, status: "open" });
ok("open has complete", openActions.some((a) => a.action === "complete"));
ok("open has park", openActions.some((a) => a.action === "park"));
ok("open has edit", openActions.some((a) => a.action === "edit"));
ok("open has delete", openActions.some((a) => a.action === "delete"));
ok("open no restore", !openActions.some((a) => a.action === "restore"));

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);