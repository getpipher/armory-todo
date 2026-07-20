/**
 * armory-todo — global, cross-session TODO for pi.
 *
 * Unlike the existing pi todo extensions (which are conversation-branch-scoped:
 * they survive compaction/reload *within one session* via appendEntry), this
 * one is backed by disk files under ~/.pi/agent/todo/ so a TODO added in
 * session A is visible in any session B. It also auto-injects an "Open TODOs"
 * block into the system prompt on every before_agent_start, so a fresh session
 * is proactively aware of pending work instead of starting blind.
 *
 * Lifecycle boxes (v0.2.0):
 *   - active  (open, in_progress) → auto-injected into the prompt
 *   - parked  (parked)            → NOT injected; one status flip from active
 *   - archive (done, cancelled)   → NOT injected; sealed history in
 *                                    todo-archive.json, recoverable via restore
 *
 * Surface: `todo` tool (model CRUD + lifecycle), `/todo` slash command (human
 * triage). See docs/superpowers/specs/2026-07-20-lifecycle-boxes-prune-design.md
 * for the design.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  addTodo,
  completeTodo,
  deleteTodo,
  clearTodos,
  listTodos,
  renderOpenBlock,
  updateTodo,
  parkTodo,
  getStorePath,
} from "../src/todo-store";
import { pruneTodos, restoreTodo, listArchived, archiveSummary } from "../src/archive";

const ACTIONS = ["list", "add", "update", "complete", "delete", "clear", "park", "prune", "restore"] as const;

function fmt(t: ReturnType<typeof listTodos>[number]): string {
  const tag = t.project ? ` (${t.project})` : "";
  const pins = t.tags.length ? ` #${t.tags.join(" #")}` : "";
  return `- [${t.id}] (${t.priority}/${t.status}) ${t.text}${tag}${pins}`;
}

export default function (pi: ExtensionAPI) {
  // Warm + report on session start (every new/resume/fork/reload).
  pi.on("session_start", async (_event, ctx) => {
    try {
      const open = listTodos();
      if (ctx.hasUI) {
        ctx.ui.notify(`armory-todo: ${open.length} open TODO${open.length === 1 ? "" : "s"}`, "info");
      }
    } catch {
      // store unavailable — never crash the session
    }
  });

  // Auto-inject the open-TODO block into the system prompt every turn so the
  // agent is always aware of pending cross-session work. Only open + in_progress
  // are injected — parked and archived are excluded (the lifecycle-box boundary).
  pi.on("before_agent_start", async (event: any) => {
    try {
      const base = (event?.systemPrompt as string | undefined) ?? "";
      const block = renderOpenBlock();
      return { systemPrompt: base + "\n\n" + block };
    } catch {
      return undefined;
    }
  });

  // Model-callable tool.
  pi.registerTool({
    name: "todo",
    label: "TODO",
    description:
      "Global cross-session TODO store (persists across ALL pi sessions, not just this one). " +
      "Use when the user says 'put this in our TODO', 'show me the TODO', 'mark <id> done', 'park <id>', 'prune', 'restore <id>', etc. " +
      "Open TODOs are auto-injected each turn; parked todos are NOT injected (deferred/someday). " +
      "Done/cancelled todos are moved to an archive by `prune` (reversible via `restore`). " +
      "Never put secrets in a TODO — the text reaches the model provider.",
    promptSnippet: "Read/update the global cross-session TODO list (active / parked / archive)",
    promptGuidelines: [
      "Use todo (action:'list') when the user asks 'show me the TODO' / 'what's pending'.",
      "Use todo (action:'add', text, project?, tags?, priority?, source?) when the user says 'put this in our TODO'.",
      "Use todo (action:'complete', id) to mark a TODO done; (action:'delete', id) to cancel it.",
      "Use todo (action:'park', id) to defer a TODO (not injected, recoverable); (action:'update', id, status:'open') to un-park.",
      "Use todo (action:'prune') to move done/cancelled todos to the archive (reversible); (action:'prune', all:true) to prune all regardless of age.",
      "Use todo (action:'restore', id) to bring an archived TODO back as open.",
      "Use todo (action:'list', archived:true) to query the archive — bare call returns a summary; add a filter (project/text/since) for specific items.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      id: Type.Optional(Type.String({ description: "Todo id (for update/complete/delete/park/restore)" })),
      text: Type.Optional(Type.String({ description: "Todo text (add) or new text (update); or substring search (list)" })),
      project: Type.Optional(Type.String({ description: "Project tag, e.g. 'pi', 'sip', or '' for global" })),
      tags: Type.Optional(Type.Array(Type.String())),
      priority: Type.Optional(StringEnum(["low", "med", "high", "critical"] as const)),
      status: Type.Optional(StringEnum(["open", "in_progress", "parked", "done", "cancelled"] as const)),
      // list filters
      statusFilter: Type.Optional(StringEnum(["open", "in_progress", "parked", "done", "cancelled", "all"] as const)),
      projectFilter: Type.Optional(Type.String()),
      tagFilter: Type.Optional(Type.String()),
      archived: Type.Optional(Type.Boolean({ description: "If true, query the archive instead of the live store. Bare archived:true (no other filter) returns a summary." })),
      since: Type.Optional(Type.String({ description: "ISO date filter (createdAt for live, closedAt for archive)" })),
      before: Type.Optional(Type.String({ description: "ISO date filter (createdAt for live, closedAt for archive)" })),
      limit: Type.Optional(Type.Number({ description: "Page size (default 20)" })),
      page: Type.Optional(Type.Number({ description: "1-indexed page number (default 1)" })),
      // prune options
      ageDays: Type.Optional(Type.Number({ description: "prune: closedAt older than this many days (default from config)" })),
      all: Type.Optional(Type.Boolean({ description: "prune: ignore age, move all done/cancelled" })),
    }),
    async execute(_toolCallId, params) {
      try {
        switch (params.action) {
          case "list": {
            if (params.archived) {
              const res = listArchived({
                project: params.projectFilter,
                tag: params.tagFilter,
                status: params.statusFilter as any,
                text: params.text,
                since: params.since,
                before: params.before,
                limit: params.limit,
                page: params.page,
              });
              if (res.summary) {
                const lines = [
                  `## Archive summary (${res.total} total)`,
                  "By project:",
                  ...Object.entries(res.summary.byProject).map(([p, n]) => `  ${p}: ${n}`),
                  "By month:",
                  ...Object.entries(res.summary.byMonth).map(([m, n]) => `  ${m}: ${n}`),
                  "Use a filter (project/tag/text/since/before) to list specific items.",
                ];
                return { content: [{ type: "text" as const, text: lines.join("\n") }] };
              }
              const lines = res.items.map(fmt);
              return { content: [{ type: "text" as const, text: `Archived (${res.total} total, page ${params.page ?? 1}):\n${lines.join("\n")}` }] };
            }
            const todos = listTodos({
              status: params.statusFilter as any,
              project: params.projectFilter,
              tag: params.tagFilter,
              text: params.text,
              since: params.since,
              before: params.before,
              limit: params.limit,
              page: params.page,
            });
            if (todos.length === 0) {
              return { content: [{ type: "text" as const, text: "No matching TODOs." }] };
            }
            return { content: [{ type: "text" as const, text: todos.map(fmt).join("\n") }] };
          }
          case "add": {
            if (!params.text) {
              return { content: [{ type: "text" as const, text: "Error: `text` is required for add." }] };
            }
            const t = addTodo({
              text: params.text,
              project: params.project,
              tags: params.tags,
              priority: params.priority as any,
              source: params.source as any,
            });
            return { content: [{ type: "text" as const, text: `Added ${t.id}: ${t.text}` }] };
          }
          case "update": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for update." }] };
            const t = updateTodo(params.id, {
              text: params.text,
              project: params.project,
              tags: params.tags,
              priority: params.priority as any,
              status: params.status as any,
            });
            return { content: [{ type: "text" as const, text: `Updated ${t.id}: ${t.text} [${t.status}]` }] };
          }
          case "complete": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for complete." }] };
            const t = completeTodo(params.id);
            return { content: [{ type: "text" as const, text: `Completed ${t.id}: ${t.text}` }] };
          }
          case "delete": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for delete." }] };
            const t = deleteTodo(params.id);
            return { content: [{ type: "text" as const, text: `Cancelled ${t.id}: ${t.text}` }] };
          }
          case "park": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for park." }] };
            const t = parkTodo(params.id);
            return { content: [{ type: "text" as const, text: `Parked ${t.id}: ${t.text}` }] };
          }
          case "prune": {
            const res = pruneTodos({ ageDays: params.ageDays, all: params.all });
            return { content: [{ type: "text" as const, text: `Pruned ${res.moved} todo${res.moved === 1 ? "" : "s"} to archive: ${res.ids.join(", ") || "(none)"}` }] };
          }
          case "restore": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for restore." }] };
            const t = restoreTodo(params.id);
            return { content: [{ type: "text" as const, text: `Restored ${t.id}: ${t.text} [open]` }] };
          }
          case "clear": {
            const n = clearTodos((params.status as any) ?? "done");
            return { content: [{ type: "text" as const, text: `Cleared ${n} '${params.status ?? "done"}' TODOs.` }] };
          }
          default:
            return { content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }] };
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
      }
    },
  });

  // Human slash command.
  pi.registerCommand("todo", {
    description:
      "Global cross-session TODO list. " +
      "/todo · /todo all · /todo add <text> · /todo done <id> · /todo rm <id> · " +
      "/todo park <id> · /todo restore <id> · /todo prune [--all] · " +
      "/todo archive [project:X|text:Y] · /todo clean · /todo path",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      const [sub, ...rest] = a.split(/\s+/);
      try {
        if (sub === "all") {
          const todos = listTodos({ status: "all" });
          const msg = todos.length ? todos.map(fmt).join("\n") : "(no TODOs at all)";
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          return;
        }
        if (sub === "add") {
          const text = rest.join(" ").trim();
          if (!text) { if (ctx.hasUI) ctx.ui.notify("usage: /todo add <text>", "warning"); return; }
          const t = addTodo({ text, source: "slash" });
          if (ctx.hasUI) ctx.ui.notify(`Added ${t.id}: ${t.text}`, "info");
          return;
        }
        if (sub === "done") {
          const id = rest[0];
          if (!id) { if (ctx.hasUI) ctx.ui.notify("usage: /todo done <id>", "warning"); return; }
          const t = completeTodo(id);
          if (ctx.hasUI) ctx.ui.notify(`Completed ${t.id}`, "info");
          return;
        }
        if (sub === "rm") {
          const id = rest[0];
          if (!id) { if (ctx.hasUI) ctx.ui.notify("usage: /todo rm <id>", "warning"); return; }
          const t = deleteTodo(id);
          if (ctx.hasUI) ctx.ui.notify(`Cancelled ${t.id}`, "info");
          return;
        }
        if (sub === "park") {
          const id = rest[0];
          if (!id) { if (ctx.hasUI) ctx.ui.notify("usage: /todo park <id>", "warning"); return; }
          const t = parkTodo(id);
          if (ctx.hasUI) ctx.ui.notify(`Parked ${t.id}: ${t.text}`, "info");
          return;
        }
        if (sub === "restore") {
          const id = rest[0];
          if (!id) { if (ctx.hasUI) ctx.ui.notify("usage: /todo restore <id>", "warning"); return; }
          const t = restoreTodo(id);
          if (ctx.hasUI) ctx.ui.notify(`Restored ${t.id}: ${t.text}`, "info");
          return;
        }
        if (sub === "prune") {
          const all = rest.includes("--all");
          const res = pruneTodos({ all });
          if (ctx.hasUI) ctx.ui.notify(`Pruned ${res.moved} todo${res.moved === 1 ? "" : "s"} to archive: ${res.ids.join(", ") || "(none)"}`, "info");
          return;
        }
        if (sub === "archive") {
          const filterArg = rest.join(" ").trim();
          if (!filterArg) {
            const s = archiveSummary();
            const lines = [
              `Archive summary (${s.total} total):`,
              "By project:",
              ...Object.entries(s.byProject).map(([p, n]) => `  ${p}: ${n}`),
              "By month:",
              ...Object.entries(s.byMonth).map(([m, n]) => `  ${m}: ${n}`),
              "Use /todo archive project:<name> or text:<query> to list specific items.",
            ];
            if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
          // parse "project:foo" or "text:query" (simple key:value)
          const parts = filterArg.split(":");
          const key = parts[0]?.trim();
          const val = parts.slice(1).join(":").trim();
          const res = key === "project" ? listArchived({ project: val, limit: 50 })
            : key === "text" ? listArchived({ text: val, limit: 50 })
            : listArchived({ text: filterArg, limit: 50 });
          const msg = res.items.length ? res.items.map(fmt).join("\n") : "(no archived items match)";
          if (ctx.hasUI) ctx.ui.notify(`Archived (${res.total} total):\n${msg}`, "info");
          return;
        }
        if (sub === "clean") {
          const n = clearTodos("done");
          if (ctx.hasUI) ctx.ui.notify(`Cleared ${n} done TODOs.`, "info");
          return;
        }
        if (sub === "path") {
          if (ctx.hasUI) ctx.ui.notify(`store: ${getStorePath()}`, "info");
          return;
        }
        // default: list open
        const todos = listTodos();
        const msg = todos.length ? todos.map(fmt).join("\n") : "(no open TODOs)";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
      } catch (err) {
        if (ctx.hasUI) ctx.ui.notify(`todo error: ${(err as Error).message}`, "warning");
      }
    },
  });
}