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
import { restoreTodo, archiveSummary, listArchived, listDoneUnified } from "./archive.ts";
import { loadConfig, saveConfig, type TodoConfig } from "./config.ts";
import { healthReport } from "./health.ts";
import { projectsOverview } from "./projects.ts";
import { renameProject, setProjectMaxOpen, loadRegistry, saveRegistry } from "./registry.ts";
import { executeTriage, type TriageReport } from "./triage.ts";
import { todoToItem, archiveSummaryToItems, actionsForTodo, configToSettingItems, todoDoneItem, actionsForDoneTodo, projectOverviewToItems, actionsForProject, noProjectSummaryItem, countReapedFromAudit, triagePanelRows, triageRowToItem, actionsForTriageRow, planBatch, batchSummary, type TriagePanelRow, type TriageVerdict } from "./panel-data.ts";

export type Box = "active" | "parked" | "done" | "archive" | "projects" | "triage" | "config";
const BOXES: Box[] = ["active", "parked", "done", "archive", "projects", "triage", "config"];

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
  private detailMode = false;
  private detailId = "";
  private settingsList: SettingsList | null = null;
  private config: TodoConfig;
  private healthFlags: string[] = [];
  private orphanIds = new Set<string>();
  private projectFilterName = "";      // set by the "Filter active to project" action
  private projectEditKind: "rename" | "setmax" | null = null;
  private projectEditName = "";       // which project is being edited
  // Triage tab (v0.8.0, PRD D5): rows carry a per-row verdict chip; `A` arms
  // the batch (press again to execute — the in-panel D2 gate), esc disarms.
  private triageRows: TriagePanelRow[] = [];
  private triageLoaded = false;
  private triageArm = false;
  private triageExecuting = false;
  private triageEditKind: "survivor" | "evidence" | null = null;
  private triageEditId = "";

  constructor(opts: TodoPanelOpts) {
    super();
    this.theme = opts.theme;
    this.onDone = opts.onDone;
    this.onNotify = opts.onNotify;
    this.config = loadConfig();

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
    this.settingsList = null; // cleared; renderConfigBox sets it if active

    const accent = (s: string) => this.theme.fg("accent", s);
    const tabs = BOXES.map((b) => b === this.currentBox ? this.theme.fg("accent", this.theme.bold(`[${b}]`)) : this.theme.fg("dim", b)).join("  ");
    this.addChild(new Text(accent(this.theme.bold("  TODO")) + "  " + tabs, 0, 0));
    if (this.healthFlags.length > 0) {
      this.addChild(new Text(this.theme.fg("warning", `  ⚠ ${this.healthFlags.length} bloat signals — see Config tab`), 0, 0));
    }
    this.addChild(new Spacer(1));
    if (this.currentBox === "triage" && !this.editMode && !this.detailMode && !this.actionMode) {
      this.addChild(new Text(this.theme.fg("muted", "  ⚡ = --yes-safe (mechanical debris) · verdicts pre-chipped conservative; override per row"), 0, 0));
    }
    this.addChild(new Text(this.theme.fg("muted", "  filter:"), 0, 0));
    this.addChild(this.filterInput);
    this.addChild(new Spacer(1));

    if (this.editMode && this.editInput) {
      const prompt = this.projectEditKind === "rename" ? `  Rename project '${this.projectEditName}' to:`
        : this.projectEditKind === "setmax" ? `  Set maxOpen for '${this.projectEditName}' (number or 'clear'):`
        : this.triageEditKind === "survivor" ? `  Survivor id for duplicate close of [${this.triageEditId}] (td-…):`
        : this.triageEditKind === "evidence" ? `  Evidence for verified-shipped close of [${this.triageEditId}] (one checked line):`
        : `  Edit [${this.editId}]:`;
      this.addChild(new Text(this.theme.fg("accent", prompt), 0, 0));
      this.addChild(this.editInput);
      this.addChild(new Text(this.theme.fg("dim", "  enter save • esc cancel"), 0, 0));
    } else if (this.actionMode && this.actionList) {
      this.addChild(new Text(this.theme.fg("accent", "  Action:"), 0, 0));
      this.addChild(this.actionList);
    } else if (this.detailMode) {
      const all = listTodos({ status: "all", limit: 200 });
      const t = all.find((x) => x.id === this.detailId);
      if (!t) { this.detailMode = false; this.renderShell(); return; }
      const proj = t.project || "no project";
      const tags = t.tags.length ? t.tags.join(" ") : "(none)";
      const notesText = t.notes || "(empty)";
      this.addChild(new Text(this.theme.fg("accent", "  " + t.title), 0, 0));
      this.addChild(new Text(this.theme.fg("muted", "  (" + t.priority + "/" + t.status + ") - " + proj + " - #" + tags), 0, 0));
      this.addChild(new Spacer(1));
      this.addChild(new Text(this.theme.fg("dim", "  notes:"), 0, 0));
      this.addChild(new Text("  " + notesText, 0, 0));
      this.addChild(new Spacer(1));
      this.addChild(new Text(this.theme.fg("dim", "  notes: read-only - todo update <id> notes=... to edit"), 0, 0));
    } else if (this.currentBox === "config") {
      this.renderConfigBox();
    } else {
      if (this.currentBox === "archive") {
        const reaped = countReapedFromAudit();
        this.addChild(new Text(this.theme.fg("muted", `  reaped: ${reaped} runs auto-cancelled · restore with todo restore <id>`), 0, 0));
        this.addChild(new Spacer(1));
      }
      if (this.currentBox === "triage" && this.triageArm) {
        const plan = planBatch(this.triageRows);
        const line = plan.errors.length > 0
          ? this.theme.fg("warning", `  ⚠ batch has problems: ${plan.errors[0]}${plan.errors.length > 1 ? ` (+${plan.errors.length - 1} more)` : ""}`)
          : this.theme.fg("warning", `  ARMED — execute ${batchSummary(plan)}? press A again to run · esc to disarm`);
        this.addChild(new Text(line, 0, 0));
        this.addChild(new Spacer(1));
      }
      this.addChild(this.selectList);
    }

    this.addChild(new Spacer(1));
    const footer = this.currentBox === "triage"
      ? "  ↑↓ navigate • enter action/verdict • A approve batch (twice) • tab switch box • esc done"
      : "  ↑↓ navigate • enter select/action • tab switch box • esc done";
    this.addChild(new Text(this.theme.fg("dim", footer), 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(accent));
    this.invalidate();
  }

  private refreshList(): void {
    const filter = this.filterInput.getValue();
    try {
      const report = healthReport();
      this.healthFlags = report.flags;
      this.orphanIds = new Set(report.orphan.ids);
    } catch {
      // health is advisory; retain the last successful snapshot
    }
    if (this.currentBox === "active") {
      const project = this.projectFilterName || undefined;
      const todos = listTodos({ project, text: filter || undefined, limit: 50 });
      this.setSelectItems(todos.map((t) => todoToItem(t, this.orphanIds.has(t.id))));
    } else if (this.currentBox === "parked") {
      const todos = listTodos({ status: "parked", text: filter || undefined, limit: 50 });
      this.setSelectItems(todos.map((t) => todoToItem(t)));
    } else if (this.currentBox === "done") {
      const items = listDoneUnified({ text: filter || undefined, limit: 50 });
      this.setSelectItems(items.map(todoDoneItem));
    } else if (this.currentBox === "archive") {
      if (!filter) {
        const s = archiveSummary();
        this.setSelectItems(archiveSummaryToItems(s));
      } else {
        const res = listArchived({ text: filter, limit: 50 });
        this.setSelectItems(res.items.map((t) => todoToItem(t)));
      }
    } else if (this.currentBox === "projects") {
      const overview = projectsOverview();
      const rows = projectOverviewToItems(overview);
      this.setSelectItems([noProjectSummaryItem(overview), ...rows]);
    } else if (this.currentBox === "triage") {
      if (!this.triageLoaded) this.reloadTriageRows();
      const q = filter.toLowerCase();
      const rows = q
        ? this.triageRows.filter((r) => r.title.toLowerCase().includes(q) || r.project.toLowerCase().includes(q))
        : this.triageRows;
      if (rows.length === 0) {
        this.setSelectItems([{ value: "__notriage__", label: this.triageRows.length === 0 ? "No triage candidates — the store is clean 🎉" : "(no rows match the filter)" }]);
      } else {
        this.setSelectItems(rows.map(triageRowToItem));
      }
    }
  }

  /** (Re)gather candidates. Called on first tab entry, on re-entry after a
   *  switch, and after a batch executes — the store may have changed. Pure read. */
  private reloadTriageRows(): void {
    try {
      this.triageRows = triagePanelRows();
      this.triageLoaded = true;
    } catch (err) {
      this.onNotify(`triage gather failed: ${(err as Error).message}`, "error");
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
    if (this.currentBox === "projects") {
      if (item.value === "__noproject__") return;   // (no project) summary — no submenu
      this.openProjectSubmenu(item.value);
      return;
    }
    if (this.currentBox === "triage") {
      if (item.value === "__notriage__") return;    // placeholder — no submenu
      this.openTriageSubmenu(item.value);
      return;
    }
    this.openActionSubmenu(item.value);
  }

  private openTriageSubmenu(id: string): void {
    const row = this.triageRows.find((r) => r.id === id);
    if (!row) { this.onNotify("Candidate not found — re-gathering.", "info"); this.reloadTriageRows(); this.refreshList(); this.renderShell(); return; }
    const items: SelectItem[] = actionsForTriageRow().map((a) => ({ value: a.action, label: a.label }));
    this.actionList = new SelectList(items, 8, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("warning", s),
    });
    this.actionList.onSelect = (a) => this.executeTriageRowAction(id, a.value);
    this.actionList.onCancel = () => { this.actionMode = false; this.actionList = null; this.renderShell(); };
    this.actionMode = true;
    this.renderShell();
  }

  private executeTriageRowAction(id: string, action: string): void {
    const row = this.triageRows.find((r) => r.id === id);
    this.actionMode = false;
    this.actionList = null;
    if (!row) { this.renderShell(); return; }
    if (action === "view") {
      this.viewDetail(id);
      return;
    }
    if (action.startsWith("v:")) {
      const verdict = action.slice(2) as TriageVerdict;
      row.verdict = verdict;
      this.triageArm = false; // batch changed — re-arm deliberately
      if (verdict === "close-duplicate") {
        this.beginTriageEdit(id, "survivor");
        return;
      }
      if (verdict === "close-shipped") {
        this.beginTriageEdit(id, "evidence");
        return;
      }
      this.onNotify(`[${id}] verdict → ${verdict}`);
    }
    this.refreshList();
    this.renderShell();
  }

  /** Inline single-line input for duplicate-survivor ids and shipped evidence
   *  (reuses the editMode Input; pi-tui cannot nest editors inside the panel). */
  private beginTriageEdit(id: string, kind: "survivor" | "evidence"): void {
    this.triageEditKind = kind;
    this.triageEditId = id;
    this.editId = id;
    this.editInput = new Input();
    this.editInput.setValue("");
    this.editInput.onSubmit = (value) => {
      const row = this.triageRows.find((r) => r.id === id);
      const v = value.trim();
      if (row) {
        if (kind === "survivor") {
          if (v) { row.survivorId = v; this.onNotify(`[${id}] duplicate of ${v}`); }
        } else {
          if (v) { row.evidence = v; this.onNotify(`[${id}] evidence recorded`); }
        }
      }
      this.triageEditKind = null;
      this.triageEditId = "";
      this.exitEditMode();
    };
    this.editInput.onEscape = () => {
      this.triageEditKind = null;
      this.triageEditId = "";
      this.exitEditMode();
    };
    this.editMode = true;
    this.renderShell();
  }

  /** The in-panel D2 gate: first `A` arms (shows the batch summary), second
   *  `A` executes. Nothing runs until that second explicit press. */
  private approveTriageBatch(): void {
    if (this.triageExecuting) return;
    const plan = planBatch(this.triageRows);
    if (!this.triageArm) {
      if (plan.close + plan.park === 0) {
        this.onNotify("Nothing to execute — every row is still 'keep'.");
        return;
      }
      this.triageArm = true;
      this.renderShell();
      return;
    }
    if (plan.errors.length > 0) {
      this.onNotify(`Batch incomplete: ${plan.errors[0]}`, "warning");
      return; // stay armed — fix rows, press A again
    }
    this.triageExecuting = true;
    this.triageArm = false;
    this.renderShell();
    executeTriage(plan.decisions)
      .then((report: TriageReport) => {
        this.triageExecuting = false;
        this.reloadTriageRows();
        this.refreshList();
        this.renderShell();
        const parts = [];
        if (report.closed.length) parts.push(`${report.closed.length} closed`);
        if (report.parked.length) parts.push(`${report.parked.length} parked`);
        if (report.kept.length) parts.push(`${report.kept.length} kept`);
        const filed = report.filings.filter((f) => f.status === "filed").length;
        const skipped = report.filings.filter((f) => f.status.startsWith("skipped")).length;
        this.onNotify(`Triage executed: ${parts.join(", ")} · filed ${filed}${skipped ? `, skipped ${skipped} (gh)` : ""} · restorable via todo restore <id>`);
      })
      .catch((err) => {
        this.triageExecuting = false;
        this.renderShell();
        this.onNotify(`Triage failed: ${(err as Error).message}`, "error");
      });
  }

  private openProjectSubmenu(name: string): void {
    const acts = actionsForProject();
    const items: SelectItem[] = acts.map((a) => ({ value: a.action, label: a.label }));
    this.actionList = new SelectList(items, 8, {
      selectedPrefix: (s) => this.theme.fg("accent", s),
      selectedText: (s) => this.theme.fg("accent", s),
      description: (s) => this.theme.fg("muted", s),
      scrollInfo: (s) => this.theme.fg("dim", s),
      noMatch: (s) => this.theme.fg("warning", s),
    });
    this.actionList.onSelect = (a) => this.executeProjectAction(name, a.value);
    this.actionList.onCancel = () => { this.actionMode = false; this.actionList = null; this.renderShell(); };
    this.actionMode = true;
    this.renderShell();
  }

  private async executeProjectAction(name: string, action: string): Promise<void> {
    try {
      if (action === "filter") {
        this.projectFilterName = name;
        this.currentBox = "active";
        this.filterInput.setValue("");   // clear text filter; scope is via projectFilterName
        this.actionMode = false; this.actionList = null;
        this.refreshList();
        this.renderShell();
        this.onNotify(`Filtered active to project: ${name}`);
        return;
      }
      if (action === "rename" || action === "setmax") {
        this.projectEditKind = action;
        this.projectEditName = name;
        this.editInput = new Input();
        this.editInput.setValue("");   // don't pre-fill: setValue leaves cursor at 0 (typing would prepend); the prompt labels the target
        this.editInput.onSubmit = (value) => {
          try {
            if (this.projectEditKind === "rename") {
              const r = renameProject(this.projectEditName, value.trim());
              this.onNotify(`Renamed ${this.projectEditName} → ${r.newName} (${r.liveRenamed} live + ${r.archivedRenamed} archived${r.merged ? ", merged" : ""})`);
            } else if (this.projectEditKind === "setmax") {
              const v = value.trim().toLowerCase();
              const max = v === "clear" || v === "" ? null : Number(v);
              if (max !== null && !Number.isFinite(max)) throw new Error("maxOpen must be a number or 'clear'");
              const reg = loadRegistry();
              setProjectMaxOpen(reg, this.projectEditName, max);
              saveRegistry(reg);
              this.onNotify(`${this.projectEditName} maxOpen = ${max === null ? "cleared" : max}`);
            }
          } catch (err) { this.onNotify((err as Error).message, "error"); }
          this.exitProjectEdit();
        };
        this.editInput.onEscape = () => this.exitProjectEdit();
        this.actionMode = false; this.actionList = null;
        this.editMode = true;
        this.renderShell();
        return;
      }
    } catch (err) {
      this.onNotify((err as Error).message, "error");
    }
    this.actionMode = false; this.actionList = null;
    this.refreshList();
    this.renderShell();
  }

  private exitProjectEdit(): void {
    this.editMode = false;
    this.editInput = null;
    this.projectEditKind = null;
    this.projectEditName = "";
    this.refreshList();
    this.renderShell();
  }

  private openActionSubmenu(id: string): void {
    let acts: { label: string; action: string }[];
    if (this.currentBox === "done") {
      const d = listDoneUnified({}).find((x) => x.id === id);
      if (!d) { this.onNotify("Done todo not found.", "info"); return; }
      acts = actionsForDoneTodo(d);
    } else {
      const all = listTodos({ status: "all", limit: 200 });
      const todo = all.find((t) => t.id === id);
      if (!todo) {
        this.onNotify("Todo not found in the live store (archive restore: use the archive box).", "info");
        return;
      }
      acts = [{ label: "View detail", action: "view" }, ...actionsForTodo(todo)];
    }
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

  private viewDetail(id: string): void {
    const all = listTodos({ status: "all", limit: 200 });
    const t = all.find((x) => x.id === id);
    if (!t) { this.onNotify("Todo not found.", "info"); return; }
    this.detailId = id;
    this.detailMode = true;
    this.actionMode = false;
    this.actionList = null;
    this.editMode = false;
    this.editInput = null;
    this.renderShell();
  }

  private async executeAction(id: string, action: string): Promise<void> {
    try {
      switch (action) {
        case "view": this.viewDetail(id); return;
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
          this.editInput.setValue(t?.title ?? "");
          this.editInput.onSubmit = (value) => {
            if (value.trim()) {
              try { updateTodo(id, { title: value.trim() }); this.onNotify(`Edited ${id}`); }
              catch (err) { this.onNotify((err as Error).message, "error"); }
            }
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
      this.onNotify((err as Error).message, "error");
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
    this.settingsList = sl;
    this.addChild(sl);
  }

  private configValueDisplay(id: string): string {
    const c = this.config;
    switch (id) {
      case "defaultAgeDays": return String(c.prune.defaultAgeDays);
      case "hardAgeDays": return String(c.prune.hardAgeDays);
      case "activeMaxOpen": return String(c.health.activeMaxOpen);
      case "activeStaleDays": return String(c.health.activeStaleDays);
      case "orphanFlagAfterDays": return String(c.reap.orphanFlagAfterDays);
      case "armoryFleetReapAfterDays": return String(c.reap.policy["armory-fleet"]?.reapAfterDays ?? 2);
      case "parkedMax": return String(c.health.parkedMax);
      case "parkedStaleDays": return String(c.health.parkedStaleDays);
      case "archiveMax": return String(c.health.archiveMax);
      case "archiveOldDays": return String(c.health.archiveOldDays);
      case "maxNotesBytes": return String(c.health.maxNotesBytes);
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
      case "orphanFlagAfterDays": this.config.reap.orphanFlagAfterDays = n; break;
      case "armoryFleetReapAfterDays": this.config.reap.policy["armory-fleet"] = { reapAfterDays: n, reapTo: "cancelled" }; break;
      case "parkedMax": this.config.health.parkedMax = n; break;
      case "parkedStaleDays": this.config.health.parkedStaleDays = n; break;
      case "archiveMax": this.config.health.archiveMax = n; break;
      case "archiveOldDays": this.config.health.archiveOldDays = n; break;
      case "maxNotesBytes": this.config.health.maxNotesBytes = n; break;
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
    this.projectFilterName = "";   // reset project scope on tab switch
    this.actionMode = false;
    this.actionList = null;
    this.triageArm = false;        // batch intent never survives a tab switch
    this.triageLoaded = false;     // re-gather on next triage entry (store may have changed)
    this.refreshList();
    this.renderShell();
  }

  handleInput(data: string): void {
    if (this.editMode && this.editInput) {
      if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
        if (this.projectEditKind) this.exitProjectEdit(); else this.exitEditMode();
        return;
      }
      this.editInput.handleInput(data);
      this.invalidate();
      return;
    }
    if (this.detailMode) {
      if (matchesKey(data, "escape") || matchesKey(data, "esc") || matchesKey(data, "enter") || matchesKey(data, "return")) {
        this.detailMode = false;
        this.detailId = "";
        this.refreshList();
        this.renderShell();
        return;
      }
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
    if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
      if (this.currentBox === "triage" && this.triageArm) {
        this.triageArm = false;   // disarm first — don't close the panel mid-approval
        this.renderShell();
        return;
      }
      this.onDone();
      return;
    }
    if (matchesKey(data, "tab")) { this.switchBox(1); return; }
    if (matchesKey(data, "shift+tab")) { this.switchBox(-1); return; }
    // Triage batch gate: capital `A` (so lowercase filter typing is unaffected).
    if (this.currentBox === "triage" && data === "A") { this.approveTriageBatch(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter") || matchesKey(data, "return")) {
      if (this.currentBox === "config" && this.settingsList) {
        this.settingsList.handleInput(data);
      } else {
        this.selectList.handleInput(data);
      }
      this.invalidate();
      return;
    }
    this.filterInput.handleInput(data);
    this.refreshList();
    this.invalidate();
  }
}
