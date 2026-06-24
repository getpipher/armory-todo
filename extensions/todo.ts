/**
 * armory-todo — global, cross-session TODO for pi.
 *
 * Unlike the existing pi todo extensions (which are conversation-branch-scoped:
 * they survive compaction/reload *within one session* via appendEntry), this
 * one is backed by a single disk file (~/.pi/agent/todo.json) so a TODO added
 * in session A is visible in any session B. It also auto-injects an "Open
 * TODOs" block into the system prompt on every before_agent_start, so a fresh
 * session is proactively aware of pending work instead of starting blind.
 *
 * Surface: `todo` tool (model CRUD), `/todo` slash command (human triage).
 * See docs/todo-SPEC.md for the design.
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
  getStorePath,
} from "../src/todo-store";

const ACTIONS = ["list", "add", "update", "complete", "delete", "clear"] as const;

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
  // agent is always aware of pending cross-session work.
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
      "Use when the user says 'put this in our TODO', 'show me the TODO', 'mark <id> done', etc. " +
      "Open TODOs are also auto-injected into your context each turn. " +
      "Never put secrets in a TODO — the text reaches the model provider.",
    promptSnippet: "Read/update the global cross-session TODO list",
    promptGuidelines: [
      "Use todo (action:'list') when the user asks 'show me the TODO' / 'what's pending'.",
      "Use todo (action:'add', text, project?, tags?, priority?, source?) when the user says 'put this in our TODO'.",
      "Use todo (action:'complete', id) to mark a TODO done, and (action:'update', id, …) to edit one.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      id: Type.Optional(Type.String({ description: "Todo id (for update/complete/delete)" })),
      text: Type.Optional(Type.String({ description: "Todo text (add) or new text (update)" })),
      project: Type.Optional(Type.String({ description: "Project tag, e.g. 'pi', 'sip', or '' for global" })),
      tags: Type.Optional(Type.Array(Type.String())),
      priority: Type.Optional(StringEnum(["low", "med", "high", "critical"] as const)),
      status: Type.Optional(StringEnum(["open", "in_progress", "done", "cancelled"] as const)),
      // list filters
      statusFilter: Type.Optional(StringEnum(["open", "in_progress", "done", "cancelled", "all"] as const)),
      projectFilter: Type.Optional(Type.String()),
      tagFilter: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        switch (params.action) {
          case "list": {
            const todos = listTodos({
              status: params.statusFilter as any,
              project: params.projectFilter,
              tag: params.tagFilter,
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

  // Human slash command: /todo [all|add <text>|done <id>|rm <id>|clean|path]
  pi.registerCommand("todo", {
    description: "Global cross-session TODO list. /todo · /todo all · /todo add <text> · /todo done <id> · /todo rm <id> · /todo clean · /todo path",
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