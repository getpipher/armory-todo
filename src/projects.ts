// Per-project scope overview for armory-todo (Feature A). Pure read that
// reconciles the registry first (lazy sync), then aggregates counts across
// the live store + archived done. The `projects` action + panel Projects tab
// + the per-project health flags all consume this shape (or its derivatives).

import { loadStore, type Todo } from "./todo-store.ts";
import { loadArchive } from "./archive.ts";
import { loadRegistry, reconcileRegistry, saveRegistry, getProjectEntry } from "./registry.ts";
import { levenshtein } from "./levenshtein.ts";

export interface ProjectOverviewRow {
  name: string;
  open: number;
  in_progress: number;
  parked: number;
  done: number;       // live done + archived done
  total: number;      // open + in_progress + parked + done
  maxOpen: number | null;
  over: boolean;      // open > maxOpen (only when maxOpen !== null)
  typo: boolean;      // total === 1 AND a near-sibling (levenshtein ≤ 2) exists
  lastUpdated: string; // max updatedAt across the project's live todos (ISO), or "" if none
}

export interface ProjectsOverview {
  rows: ProjectOverviewRow[];   // sorted: open desc → total desc → name asc
  totalTodos: number;           // sum of rows' total
  noProject: { count: number; open: number };  // the (no project) bucket, not a row
}

export function projectsOverview(): ProjectsOverview {
  const live = loadStore();
  const archive = loadArchive();
  const archivedDone = archive.todos.filter((t) => t.status === "done");

  // reconcile registry first (lazy sync), persist iff changed
  const reg = loadRegistry();
  const { reg: synced, changed } = reconcileRegistry(reg, live.todos, archive.todos);
  if (changed) saveRegistry(synced);

  const liveBy = new Map<string, Todo[]>();
  for (const t of live.todos) {
    const key = t.project.trim();
    const list = liveBy.get(key) ?? [];
    list.push(t);
    liveBy.set(key, list);
  }
  const archivedDoneBy = new Map<string, number>();
  for (const t of archivedDone) {
    const key = t.project.trim();
    archivedDoneBy.set(key, (archivedDoneBy.get(key) ?? 0) + 1);
  }

  const names = new Set<string>([...liveBy.keys(), ...archivedDoneBy.keys()].filter((n) => n !== ""));

  let totalTodos = 0;
  const rows: ProjectOverviewRow[] = [];
  for (const name of names) {
    const liveForName = liveBy.get(name) ?? [];
    const open = liveForName.filter((t) => t.status === "open").length;
    const in_progress = liveForName.filter((t) => t.status === "in_progress").length;
    const parked = liveForName.filter((t) => t.status === "parked").length;
    const done = liveForName.filter((t) => t.status === "done").length + (archivedDoneBy.get(name) ?? 0);
    const total = open + in_progress + parked + done;
    totalTodos += total;
    const entry = getProjectEntry(synced, name);
    const maxOpen = entry?.maxOpen ?? null;
    const over = maxOpen !== null && open > maxOpen;
    const lastUpdated = liveForName.length
      ? liveForName.map((t) => t.updatedAt).sort().at(-1) ?? ""
      : "";
    rows.push({ name, open, in_progress, parked, done, total, maxOpen, over, typo: false, lastUpdated });
  }

  // typo: total === 1 AND a near-sibling (levenshtein ≤ 2) among other names
  for (const row of rows) {
    if (row.total === 1) {
      row.typo = [...names].some((other) => other !== row.name && levenshtein(row.name, other) <= 2);
    }
  }

  // (no project) bucket
  const noProjectLive = live.todos.filter((t) => t.project.trim() === "");
  const noProjectArchivedDone = archivedDone.filter((t) => t.project.trim() === "");
  const noProject = {
    count: noProjectLive.length + noProjectArchivedDone.length,
    open: noProjectLive.filter((t) => t.status === "open").length,
  };

  rows.sort((a, b) => b.open - a.open || b.total - a.total || a.name.localeCompare(b.name));
  return { rows, totalTodos, noProject };
}