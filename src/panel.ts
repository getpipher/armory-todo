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
  type SelectItem,
  type Theme,
} from "@earendil-works/pi-tui";
import { listTodos, parkTodo, completeTodo, deleteTodo, updateTodo, type Todo, type Status } from "./todo-store.ts";
import { restoreTodo, archiveSummary, listArchived } from "./archive.ts";
import { loadConfig, saveConfig, type TodoConfig } from "./config.ts";
import { healthReport } from "./health.ts";
import { todoToItem, archiveSummaryToItems, actionsForTodo, configToSettingItems } from "./panel-data.ts";

export type Box = "active" | "parked" | "archive" | "config";
const BOXES: Box[] = ["active", "parked", "archive", "config"];

export interface TodoPanelOpts {
  theme: Theme;
  onDone: () => void;
  onNotify: (msg: string, type?: "info" | "warning" | "error") => void;
}

export class TodoPanel extends Container {
  private readonly theme: Theme;
  private readonly onDone: () => void;
  private readonly onNotify: (msg: string, type?: "info" | "warning" | "error") => void;
  private currentBox: Box = "active";
  private filterInput: Input;
  private selectList: SelectList;
  private actionMode = false;
  private actionList: SelectList | null = null;
  private editMode = false;
  private editInput: Input | null = null;
  private editId = "";
  private config: TodoConfig;
  private healthFlags: string[] = [];

  constructor(opts: TodoPanelOpts) {
    super();
    this.theme = opts.theme;
    this.onDone = opts.onDone;
    this.onNotify = opts.onNotify;
    this.config = loadConfig();
    try { this.healthFlags = healthReport().flags; } catch { /* optional */ }

    const accent = (s: string) => this.theme.fg("accent", s);
    this.addChild(new DynamicBorder(accent));
    this.addChild(new Spacer(1));

    this.filterInput = new Input();
    this.filterInput.onEscape = () => { this.onDone(); };

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
    this.addChild(new Text(this.theme.fg("muted", "  filter:"), 0, 0));
    this.addChild(this.filterInput);
    this.addChild(new Spacer(1));

    if (this.editMode && this.editInput) {
      this.addChild(new Text(this.theme.fg("accent", `  Edit [${this.editId}]:`), 0, 0));
      this.addChild(this.editInput);
      this.addChild(new Text(this.theme.fg("dim", "  enter save • esc cancel"), 0, 0));
    } else if (this.actionMode && this.actionList) {
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
    this.selectList = fresh;
    this.renderShell();
  }

  private onItemSelect(item: SelectItem): void {
    if (this.currentBox === "archive" && (item.value === "total" || item.value.startsWith("project:") || item.value.startsWith("month:"))) {
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
    const all = listTodos({ status: "all", limit: 200 });
    const todo = all.find((t) => t.id === id);
    if (!todo) {
      this.onNotify("Todo not found in the live store (archive restore: use the archive box).", "info");
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
          this.editId = id;
          this.editInput = new Input();
          this.editInput.setValue(t?.text ?? "");
          this.editInput.onSubmit = (value) => {
            if (value.trim()) { updateTodo(id, { text: value.trim() }); this.onNotify(`Edited ${id}`); }
            this.exitEditMode();
          };
          this.editInput.onEscape = () => this.exitEditMode();
          this.actionMode = false;
          this.actionList = null;
          this.editMode = true;
          this.renderShell();
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

  private exitEditMode(): void {
    this.editMode = false;
    this.editInput = null;
    this.editId = "";
    this.refreshList();
    this.renderShell();
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
    if (this.editMode && this.editInput) {
      if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
        this.exitEditMode();
        return;
      }
      this.editInput.handleInput(data);
      this.invalidate();
      return;
    }
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