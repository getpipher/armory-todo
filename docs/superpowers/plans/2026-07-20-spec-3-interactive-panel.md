# SPEC-3: Interactive `/todo` TUI Panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn `/todo` from a series of typed commands into a real interactive triage surface — a pi-tui panel with box tabs (Active / Parked / Archive / Config), a filter input, an action submenu on Enter, and live-persist config editing. Adopts the `@getpipher/cursor` + `@getpipher/vision` pattern.

**Architecture:** A `TodoPanel` class (Container subclass, like `VisionModelPicker`) in `src/panel.ts` encapsulates the whole panel — box tabs, filter Input, SelectList, action submenu, Config SettingsList. Pure data helpers in `src/panel-data.ts` are unit-testable; the TUI component itself is manual-gate. The extension wires `/todo` (no-arg) → `ctx.ui.custom()` in TUI mode; non-TUI falls back to the existing text notify.

**Tech Stack:** `@earendil-works/pi-tui` (Container, Spacer, Text, SelectList, Input, SettingsList, matchesKey, SelectItem, SettingItem, Component) + `@earendil-works/pi-coding-agent` (DynamicBorder, Theme). Zero new runtime deps.

**Design doc:** `docs/superpowers/specs/2026-07-20-lifecycle-boxes-prune-design.md` §10 (slash command + interactive panel).

## Global Constraints

- **TUI-only panel**; non-TUI (`ctx.mode !== "tui"`) falls back to `ctx.ui.notify` text status (the existing behavior).
- **Live apply + persist** on each change (writes `todo.json` / `todo-archive.json` / `todo.config.json` immediately, like `/vision` writes `vision.json`).
- **Escape exits** the panel; arrow keys navigate; Enter selects/edits/opens sub-picker; Tab cycles boxes.
- **Power-user typed subcommands retained** — `/todo park <id>`, `/todo prune`, etc. all still work; only `/todo` (no-arg) opens the panel.
- **No new runtime deps.** pi-tui + pi-coding-agent are already peer deps.
- 2-space indent, no TODO/FIXME.

---

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `src/panel-data.ts` | Pure helpers: `todoToItem(t)`, `archiveSummaryToItems(s)`, `actionsForTodo(t)`, `configToSettingItems(cfg)`. Unit-testable. | Create |
| `src/panel.ts` | `TodoPanel` class (Container) — the full interactive panel. Manual-gate. | Create |
| `extensions/todo.ts` | `/todo` (no-arg) → `ctx.ui.custom(panel)` in TUI mode; non-TUI fallback unchanged. | Modify |
| `test/panel-data.test.mts` | Pure helper tests. | Create |

---

## Task 1: `panel-data.ts` — pure helpers + tests

**Files:**
- Create: `src/panel-data.ts`, `test/panel-data.test.mts`

**Interfaces:**
- Produces: `todoToItem(t: Todo): SelectItem`, `archiveSummaryToItems(s: ArchiveSummary): SelectItem[]`, `actionsForTodo(t: Todo): { label: string; action: string }[]`, `configToSettingItems(cfg: TodoConfig): SettingItem[]`.

- [ ] **Step 1: Write the failing test**

Create `test/panel-data.test.mts`:

```ts
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

// actionsForTodo — open todo: complete, park, edit, delete
const openActions = actionsForTodo({ ...t, status: "open" });
ok("open has complete", openActions.some((a) => a.action === "complete"));
ok("open has park", openActions.some((a) => a.action === "park"));
ok("open has edit", openActions.some((a) => a.action === "edit"));
ok("open has delete", openActions.some((a) => a.action === "delete"));
ok("open no restore", !openActions.some((a) => a.action === "restore"));

// parked todo: un-park (open), complete, delete
const parkedActions = actionsForTodo({ ...t, status: "parked" });
ok("parked has open", parkedActions.some((a) => a.action === "open"));
ok("parked has complete", parkedActions.some((a) => a.action === "complete"));

// done todo: restore (if archived context) — but actionsForTodo works on live status
const doneActions = actionsForTodo({ ...t, status: "done" });
ok("done has restore", doneActions.some((a) => a.action === "restore"));

// archiveSummaryToItems
const summaryItems = archiveSummaryToItems({ total: 5, byProject: { nuntius: 3, "(none)": 2 }, byMonth: { "2026-07": 4, "2026-06": 1 } });
ok("summary has total item", summaryItems.some((i) => i.label.includes("total") || i.value === "total"));
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/panel-data.test.mts`
Expected: FAIL — `Cannot find module '../src/panel-data.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `src/panel-data.ts`:

```ts
// Pure data helpers for the /todo TUI panel (SPEC-3). Kept separate from
// panel.ts so they're unit-testable without a terminal — the panel component
// itself is manual-gate only.

import type { SelectItem, SettingItem } from "@earendil-works/pi-tui";
import type { Todo } from "./todo-store.ts";
import type { ArchiveSummary } from "./archive.ts";
import type { TodoConfig } from "./config.ts";

/** Format a todo as a SelectList item: "[id] (prio)⏵ text (project)". */
export function todoToItem(t: Todo): SelectItem {
  const pin = t.status === "in_progress" ? " ⏵" : "";
  const proj = t.project ? ` (${t.project})` : "";
  return {
    value: t.id,
    label: `[${t.id}] (${t.priority})${pin} ${t.text}${proj}`,
  };
}

/** Format an archive summary into SelectList items (project + month buckets). */
export function archiveSummaryToItems(s: ArchiveSummary): SelectItem[] {
  const items: SelectItem[] = [{ value: "total", label: `Total: ${s.total}` }];
  for (const [p, n] of Object.entries(s.byProject)) items.push({ value: `project:${p}`, label: `  project ${p}: ${n}` });
  for (const [m, n] of Object.entries(s.byMonth)) items.push({ value: `month:${m}`, label: `  ${m}: ${n}` });
  return items;
}

/** Available actions for a todo, depending on its status. */
export function actionsForTodo(t: Todo): { label: string; action: string }[] {
  const actions: { label: string; action: string }[] = [];
  if (t.status === "open" || t.status === "in_progress") {
    actions.push({ label: "Complete", action: "complete" });
    actions.push({ label: "Park (defer)", action: "park" });
  }
  if (t.status === "parked") {
    actions.push({ label: "Re-activate (open)", action: "open" });
    actions.push({ label: "Complete", action: "complete" });
  }
  if (t.status === "done" || t.status === "cancelled") {
    actions.push({ label: "Restore (from archive)", action: "restore" });
  }
  actions.push({ label: "Edit text", action: "edit" });
  actions.push({ label: "Delete (cancel)", action: "delete" });
  return actions;
}

/** Config → SettingsList rows (editable, live-persist). */
export function configToSettingItems(cfg: TodoConfig): SettingItem[] {
  return [
    { id: "defaultAgeDays", label: "Prune age (days)", currentValue: String(cfg.prune.defaultAgeDays), values: ["3", "7", "14", "30"], description: "Done/cancelled older than this → archive on prune." },
    { id: "hardAgeDays", label: "Hard-prune age (days)", currentValue: String(cfg.prune.hardAgeDays), values: ["90", "180", "365"], description: "Archive items older than this → suggested for hard-prune." },
    { id: "activeMaxOpen", label: "Active max open", currentValue: String(cfg.health.activeMaxOpen), values: ["10", "15", "20", "25"], description: "Bloat flag when open+in_progress exceeds this." },
    { id: "activeStaleDays", label: "Active stale (days)", currentValue: String(cfg.health.activeStaleDays), values: ["14", "30", "60"], description: "Bloat flag when open todos untouched longer than this." },
    { id: "parkedMax", label: "Parked max", currentValue: String(cfg.health.parkedMax), values: ["5", "10", "15"], description: "Bloat flag when parked exceeds this." },
    { id: "parkedStaleDays", label: "Parked stale (days)", currentValue: String(cfg.health.parkedStaleDays), values: ["30", "60", "90"], description: "Bloat flag when parked longer than this." },
    { id: "archiveMax", label: "Archive max", currentValue: String(cfg.health.archiveMax), values: ["100", "200", "500"], description: "Bloat flag when archive exceeds this." },
    { id: "archiveOldDays", label: "Archive old (days)", currentValue: String(cfg.health.archiveOldDays), values: ["90", "180", "365"], description: "Bloat flag when archive items older than this." },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/panel-data.test.mts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/panel-data.ts test/panel-data.test.mts
git commit -m "feat(panel-data): pure helpers for the /todo TUI panel (todoToItem, actionsForTodo, configToSettingItems)"
```

---

## Task 2: `TodoPanel` class — scaffold + box tabs + active box list

**Files:**
- Create: `src/panel.ts`

This task builds the panel shell (DynamicBorder framing, title, box-tab state, footer hints) + the Active box (SelectList + Input filter). Parked/Archive/Config boxes are added in Tasks 3–5.

**Interfaces:**
- Consumes: `listTodos`, `parkTodo`, `completeTodo`, `deleteTodo`, `updateTodo`, `restoreTodo` from the store modules; `archiveSummary`, `listArchived` from archive; `loadConfig`, `saveConfig` from config; `healthReport` from health; the pure helpers from `panel-data.ts`.
- Produces: `TodoPanel` class (extends Container) + `createTodoPanel(opts)` factory used by the extension.

- [ ] **Step 1: (manual gate — TUI component)**

- [ ] **Step 2: (skipped)**

- [ ] **Step 3: Write minimal implementation**

Create `src/panel.ts`:

```ts
// Interactive /todo TUI panel (SPEC-3) — a Container subclass adopting the
// @getpipher/cursor + @getpipher/vision pattern. Box tabs (Active / Parked /
// Archive / Config), a filter Input, a SelectList, an action submenu on Enter,
// and a SettingsList for config. Live-persist on every change. Non-TUI modes
// fall back to ctx.ui.notify (handled by the extension, not here).
//
// Manual-gate: the pi-tui components need a real terminal. The pure data
// helpers (panel-data.ts) are unit-tested; this component is verified in a
// real pi session.

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  SelectList,
  SettingsList,
  Spacer,
  Text,
  matchesKey,
  type Component,
  type SelectItem,
  type Theme,
} from "@earendil-works/pi-tui";
import { listTodos, parkTodo, completeTodo, deleteTodo, updateTodo, type Todo, type Status } from "./todo-store.ts";
import { restoreTodo, archiveSummary, listArchived, type ArchiveSummary } from "./archive.ts";
import { loadConfig, saveConfig, type TodoConfig } from "./config.ts";
import { healthReport } from "./health.ts";
import { todoToItem, archiveSummaryToItems, actionsForTodo, configToSettingItems } from "./panel-data.ts";

export type Box = "active" | "parked" | "archive" | "config";
const BOXES: Box[] = ["active", "parked", "archive", "config"];

export interface TodoPanelOpts {
  theme: Theme;
  onDone: () => void;
  onNotify: (msg: string, type?: "info" | "warning" | "error") => void;
  onEdit: (title: string, prefill: string) => Promise<string | undefined>;
}

export class TodoPanel extends Container {
  private readonly theme: Theme;
  private readonly onDone: () => void;
  private readonly onNotify: (msg: string, type?: "info" | "warning" | "error") => void;
  private readonly onEdit: (title: string, prefill: string) => Promise<string | undefined>;
  private currentBox: Box = "active";
  private readonly filterInput: Input;
  private readonly selectList: SelectList;
  private actionMode = false;
  private actionList: SelectList | null = null;
  private config: TodoConfig;
  private healthFlags: string[] = [];

  constructor(opts: TodoPanelOpts) {
    super();
    this.theme = opts.theme;
    this.onDone = opts.onDone;
    this.onNotify = opts.onNotify;
    this.onEdit = opts.onEdit;
    this.config = loadConfig();
    try { this.healthFlags = healthReport().flags; } catch { /* optional */ }

    const accent = (s: string) => this.theme.fg("accent", s);
    this.addChild(new DynamicBorder(accent));
    this.addChild(new Spacer(1));

    this.filterInput = new Input();
    this.filterInput.onEscape = () => { this.onDone(); };
    this.filterInput.onSubmit = () => { this.refreshList(); };

    this.selectList = new SelectList([], 12, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("warning", s),
    });
    this.selectList.onSelect = (item) => this.onItemSelect(item);
    this.selectList.onCancel = () => { this.onDone(); };

    this.refreshList();
    this.renderShell();
  }

  private renderShell(): void {
    // Keep children 0 (top border) + 1 (spacer); rebuild the rest.
    const keep = this.children.slice(0, 2);
    this.children.length = 0;
    this.children.push(...keep);

    const accent = (s: string) => this.theme.fg("accent", s);
    const tabs = BOXES.map((b) => b === this.currentBox ? this.theme.fg("accent", this.theme.bold(`[${b}]`)) : this.theme.fg("dim", b)).join("  ");
    this.addChild(new Text(accent(this.theme.bold("  TODO")) + "  " + tabs, 0, 0));
    if (this.healthFlags.length > 0) {
      this.addChild(new Text(this.theme.fg("warning", `  ⚠ ${this.healthFlags.length} bloat signals — see Config tab`), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("muted", `  filter:`), 0, 0));
    this.addChild(this.filterInput);
    this.addChild(new Spacer(1));

    if (this.actionMode && this.actionList) {
      this.addChild(new Text(this.theme.fg("accent", "  Action:"), 0, 0));
      this.addChild(this.actionList);
    } else if (this.currentBox === "config") {
      this.renderConfigBox();
    } else {
      this.addChild(this.selectList);
    }

    this.addChild(new Spacer(1));
    this.addChild(new Text(this.theme.fg("dim", "  ↑↓ navigate • enter select/action • tab switch box • esc done"), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(accent));
    this.invalidate();
  }

  private refreshList(): void {
    const filter = this.filterInput.getValue();
    if (this.currentBox === "active") {
      const todos = listTodos({ text: filter || undefined, limit: 50 });
      this.selectList.setFilter(""); // SelectList has its own filter; we pre-filter instead
      // Rebuild items
      this.setSelectItems(todos.map(todoToItem));
    } else if (this.currentBox === "parked") {
      const todos = listTodos({ status: "parked", text: filter || undefined, limit: 50 });
      this.setSelectItems(todos.map(todoToItem));
    } else if (this.currentBox === "archive") {
      if (!filter) {
        const s = archiveSummary();
        this.setSelectItems(archiveSummaryToItems(s));
      } else {
        const res = listArchived({ text: filter, limit: 50 });
        this.setSelectItems(res.items.map(todoToItem));
      }
    }
  }

  /** Replace the SelectList's items by reconstructing it (SelectList has no
   *  public items setter; setFilter does fuzzy matching on the original list). */
  private setSelectItems(items: SelectItem[]): void {
    // SelectList filters internally via setFilter; to replace items we create
    // a fresh instance preserving the theme + callbacks.
    const wasSelected = this.selectList.getSelectedItem();
    const fresh = new SelectList(items, 12, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("warning", s),
    });
    fresh.onSelect = (item) => this.onItemSelect(item);
    fresh.onCancel = () => { this.onDone(); };
    if (wasSelected) {
      const idx = items.findIndex((i) => i.value === wasSelected.value);
      if (idx >= 0) fresh.setSelectedIndex(idx);
    }
    // Replace the field reference so renderShell uses the new list
    (this as any).selectList = fresh;
    this.renderShell();
  }

  private onItemSelect(item: SelectItem): void {
    if (this.currentBox === "archive" && (item.value === "total" || item.value.startsWith("project:") || item.value.startsWith("month:"))) {
      // Drill down: set the filter to the bucket and refresh
      if (item.value.startsWith("project:")) {
        this.filterInput.setValue(item.value.slice("project:".length));
      } else if (item.value.startsWith("month:")) {
        this.filterInput.setValue(item.value.slice("month:".length));
      }
      this.refreshList();
      this.renderShell();
      return;
    }
    this.openActionSubmenu(item.value);
  }

  private openActionSubmenu(id: string): void {
    // Find the todo to determine available actions
    const all = listTodos({ status: "all", limit: 200 });
    const todo = all.find((t) => t.id === id);
    if (!todo) {
      // Maybe in archive
      const arch = listArchived({ text: id, limit: 50 });
      if (arch.items.length > 0) {
        this.onNotify("Restore from archive via the archive box.", "info");
      }
      return;
    }
    const acts = actionsForTodo(todo);
    const items: SelectItem[] = acts.map((a) => ({ value: a.action, label: a.label }));
    this.actionList = new SelectList(items, 8, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("warning", s),
    });
    this.actionList.onSelect = (a) => this.executeAction(id, a.value);
    this.actionList.onCancel = () => { this.actionMode = false; this.actionList = null; this.renderShell(); };
    this.actionMode = true;
    this.renderShell();
  }

  private async executeAction(id: string, action: string): Promise<void> {
    try {
      switch (action) {
        case "complete": completeTodo(id); this.onNotify(`Completed ${id}`); break;
        case "park": parkTodo(id); this.onNotify(`Parked ${id}`); break;
        case "open": updateTodo(id, { status: "open" as Status }); this.onNotify(`Re-activated ${id}`); break;
        case "restore": restoreTodo(id); this.onNotify(`Restored ${id}`); break;
        case "delete": deleteTodo(id); this.onNotify(`Cancelled ${id}`); break;
        case "edit": {
          const all = listTodos({ status: "all", limit: 200 });
          const t = all.find((x) => x.id === id);
          const edited = await this.onEdit("Edit TODO text", t?.text ?? "");
          if (edited !== undefined) { updateTodo(id, { text: edited }); this.onNotify(`Edited ${id}`); }
          break;
        }
      }
    } catch (err) {
      this.onNotify(`Error: ${(err as Error).message}`, "error");
    }
    this.actionMode = false;
    this.actionList = null;
    this.refreshList();
    this.renderShell();
  }

  private renderConfigBox(): void {
    const settings = configToSettingItems(this.config);
    const sl = new SettingsList(settings, 12, {
      label: (text, sel) => sel ? this.theme.fg("accent", this.theme.bold(text)) : text,
      value: (text, sel) => sel ? this.theme.fg("accent", text) : this.theme.fg("muted", text),
      description: (text) => this.theme.fg("dim", text),
      cursor: "❯",
      hint: (text) => this.theme.fg("dim", text),
    },
    (id, newValue) => {
      this.applyConfigChange(id, newValue);
      sl.updateValue(id, this.configValueDisplay(id));
    },
    () => { this.onDone(); });
    this.addChild(sl);
  }

  private configValueDisplay(id: string): string {
    const c = this.config;
    switch (id) {
      case "defaultAgeDays": return String(c.prune.defaultAgeDays);
      case "hardAgeDays": return String(c.prune.hardAgeDays);
      case "activeMaxOpen": return String(c.health.activeMaxOpen);
      case "activeStaleDays": return String(c.health.activeStaleDays);
      case "parkedMax": return String(c.health.parkedMax);
      case "parkedStaleDays": return String(c.health.parkedStaleDays);
      case "archiveMax": return String(c.health.archiveMax);
      case "archiveOldDays": return String(c.health.archiveOldDays);
      default: return "";
    }
  }

  private applyConfigChange(id: string, value: string): void {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    switch (id) {
      case "defaultAgeDays": this.config.prune.defaultAgeDays = n; break;
      case "hardAgeDays": this.config.prune.hardAgeDays = n; break;
      case "activeMaxOpen": this.config.health.activeMaxOpen = n; break;
      case "activeStaleDays": this.config.health.activeStaleDays = n; break;
      case "parkedMax": this.config.health.parkedMax = n; break;
      case "parkedStaleDays": this.config.health.parkedStaleDays = n; break;
      case "archiveMax": this.config.health.archiveMax = n; break;
      case "archiveOldDays": this.config.health.archiveOldDays = n; break;
    }
    saveConfig(this.config);
    this.onNotify(`Config saved: ${id} = ${value}`, "info");
  }

  private switchBox(dir: 1 | -1): void {
    const idx = BOXES.indexOf(this.currentBox);
    const next = (idx + dir + BOXES.length) % BOXES.length;
    this.currentBox = BOXES[next]!;
    this.filterInput.setValue("");
    this.actionMode = false;
    this.actionList = null;
    this.refreshList();
    this.renderShell();
  }

  handleInput(data: string): void {
    if (this.actionMode && this.actionList) {
      if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
        this.actionMode = false;
        this.actionList = null;
        this.renderShell();
        return;
      }
      this.actionList.handleInput(data);
      this.invalidate();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "esc")) { this.onDone(); return; }
    if (matchesKey(data, "tab")) { this.switchBox(1); return; }
    if (matchesKey(data, "shift+tab")) { this.switchBox(-1); return; }
    // Navigation keys → SelectList; everything else → filter Input
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter") || matchesKey(data, "return")) {
      this.selectList.handleInput(data);
      this.invalidate();
      return;
    }
    this.filterInput.handleInput(data);
    this.refreshList();
    this.invalidate();
  }
}
```

- [ ] **Step 4: Verify syntax**

Run: `node --check src/panel.ts`
Expected: exit 0 (syntax valid — may have import-resolution warnings but syntax passes)

- [ ] **Step 5: Commit**

```bash
git add src/panel.ts
git commit -m "feat(panel): TodoPanel — interactive /todo TUI with box tabs, filter, actions, config"
```

---

## Task 3: Extension wiring — `/todo` (no-arg) opens the panel

**Files:**
- Modify: `extensions/todo.ts`

- [ ] **Step 1: (manual gate)**

- [ ] **Step 3: Write minimal implementation**

In `extensions/todo.ts`, add the import + update the slash handler so `/todo` (no-arg, empty `sub`) opens the panel in TUI mode:

```ts
import { TodoPanel } from "../src/panel";
```

In the slash handler, the default branch (currently `// default: list open`) becomes:

```ts
        // default: open the interactive panel (TUI) or list open (non-TUI)
        if (ctx.mode === "tui") {
          await ctx.ui.custom<boolean>((_tui, theme, _kb, done) => {
            const panel = new TodoPanel({
              theme: theme as any,
              onDone: () => done(true),
              onNotify: (msg, type) => ctx.ui.notify(msg, type ?? "info"),
              onEdit: (title, prefill) => ctx.ui.editor(title, prefill),
            });
            return {
              render: (width: number) => panel.render(width),
              invalidate: () => panel.invalidate(),
              handleInput: (data: string) => panel.handleInput(data),
              dispose: () => { panel.dispose?.(); },
            } as any;
          });
          return;
        }
        // non-TUI fallback: list open as text
        const todos = listTodos();
        const msg = todos.length ? todos.map(fmt).join("\n") : "(no open TODOs)";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
```

- [ ] **Step 4: Verify syntax**

Run: `node --check extensions/todo.ts`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add extensions/todo.ts
git commit -m "feat(ext): /todo (no-arg) opens the interactive TUI panel; non-TUI fallback unchanged"
```

---

## Task 4: README + AGENTS.md + final verification

**Files:**
- Modify: `README.md`, `AGENTS.md`

- [ ] **Step 3: Write the updates**

In `README.md`, add an "Interactive panel" subsection:

```markdown
## Interactive panel (SPEC-3)

Run `/todo` (no arg) in a TUI session to open the interactive triage panel:

- **Box tabs** (Tab / Shift+Tab): Active · Parked · Archive · Config
- **Filter input**: type to search by text (live filter)
- **SelectList**: arrow keys navigate, Enter selects
- **Action submenu** (on Enter): Complete / Park / Re-activate / Restore / Edit text / Delete
- **Archive box**: summary-first (counts by project + month) → Enter on a bucket to drill down
- **Config box**: SettingsList with prune ages + health thresholds — edit live, persists to `todo.config.json`
- **Escape**: exit the panel

Typed subcommands (`/todo park <id>`, `/todo prune`, etc.) all still work alongside the panel. Non-TUI sessions (`pi -p`, RPC) fall back to the text list.
```

Update `AGENTS.md` Structure to include `src/panel.ts` + `src/panel-data.ts`, and the test count (add `panel-data`).

Update `package.json` test script to include `panel-data`:
```
"test": "for t in todo-store todo-archive todo-config todo-migrate todo-health todo-hard-prune panel-data; do node test/$t.test.mts || exit 1; done"
```

- [ ] **Step 4: Run all tests**

Run: `for t in todo-store todo-archive todo-config todo-migrate todo-health todo-hard-prune panel-data; do node test/$t.test.mts || exit 1; done`
Expected: all 7 suites PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md package.json
git commit -m "docs(spec-3): interactive /todo TUI panel + final test count"
```

---

## Final verification (SPEC-3 done → full v0.2.0 ready for QA)

- [ ] All 7 test suites pass.
- [ ] `node --check extensions/todo.ts` + `node --check src/panel.ts` pass.
- [ ] No `TODO`/`FIXME`/`HACK` in delivered code.
- [ ] **Manual QA (the one big gate, after SPEC-3):** local install → restart pi → `/todo` opens the panel → Tab through boxes → filter → Enter on a todo → action submenu → Complete/Park/Restore → Config tab edit → Escape exits. Plus the SPEC-1/2 gates (park drops from injection, prune, archive, restore, health, hard-prune confirm).
- [ ] After QA green → merge PR #3 → tag `v0.2.0` → CI auto-publishes → switch back to `npm:@getpipher/armory-todo`.

## Out of scope for SPEC-3

- **Workstream B** — `title` + `notes`/`log` schema split.
- **Workstream C** — preventive caps-on-add + project registry.