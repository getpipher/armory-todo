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
  getTodo,
  listTodos,
  renderOpenBlock,
  updateTodo,
  parkTodo,
  getStorePath,
} from "../src/todo-store";
import { pruneTodos, restoreTodo, listArchived, archiveSummary, listDoneUnified } from "../src/archive";
import { healthReport } from "../src/health";
import { hardPrune } from "../src/hard-prune";
import { TodoPanel } from "../src/panel";
import { autoPruneOnSessionStart } from "../src/auto-prune";
import { reapStaleActive } from "../src/reap";
import {
  gatherCandidates,
  executeTriage,
  executeSafeClass,
  renderProposalTable,
  renderReport,
  type TriageDecision,
} from "../src/triage";
import { buildTriagePrompt, TRIAGE_PROMPT_VERSION } from "../src/triage-prompt";
import { loadConfig, type TodoConfig } from "../src/config";
import { projectsOverview } from "../src/projects";
import { renameProject } from "../src/registry";
import { readAndClearWipeAlert } from "../src/backup";

const ACTIONS = ["list", "add", "update", "get", "complete", "delete", "clear", "park", "prune", "restore", "health", "projects", "project_rename", "triage"] as const;

function fmt(t: ReturnType<typeof listTodos>[number]): string {
  const tag = t.project ? ` (${t.project})` : "";
  const pins = t.tags.length ? ` #${t.tags.join(" #")}` : "";
  const dot = t.notes.trim() ? " •" : "";
  return `- [${t.id}] (${t.priority}/${t.status})${dot} ${t.title}${tag}${pins}`;
}

function fmtFull(t: ReturnType<typeof getTodo>): string {
  const tag = t.project ? ` (${t.project})` : "";
  const tags = t.tags.length ? ` #${t.tags.join(" #")}` : "";
  return [
    `${t.id} [${t.priority}/${t.status}] ${t.title}${tag}${tags}`,
    `created: ${t.createdAt}`,
    `updated: ${t.updatedAt}`,
    `closed: ${t.closedAt ?? "(open)"}`,
    `source: ${t.source || "(none)"}`,
    "",
    "notes:",
    t.notes || "(empty)",
  ].join("\n");
}

function fmtDone(d: ReturnType<typeof listDoneUnified>[number]): string {
  const tag = d.project ? ` (${d.project})` : "";
  const loc = d.location === "archive" && d.archivedAt
    ? ` [archived ${d.archivedAt.slice(0, 10)}]`
    : ` [live ${d.closedAt ? Math.floor((Date.now() - Date.parse(d.closedAt)) / 86400_000) : 0}d]`;
  return `- [${d.id}] (done)${tag} ${d.title}${loc}`;
}

export default function (pi: ExtensionAPI) {
  // Warm + report on session start (every new/resume/fork/reload).
  pi.on("session_start", async (_event, ctx) => {
    try {
      // v0.5.2: surface a pending wipe-alert sentinel FIRST (most prominent).
      let wipeMsg = "";
      try {
        const alert = readAndClearWipeAlert();
        if (alert) {
          wipeMsg = `⚠ WIPE RECOVERED: ${alert.before}→${alert.after} at ${alert.at}${alert.snap ? `, snap=${alert.snap}` : ""} — check ~/.pi/agent/todo/todo-audit.log + run \`ps aux | grep -iE 'tsx|pi'\` to catch the wiper live`;
        }
      } catch {
        // alert optional
      }
      // One config load reused for the prune age + the notify-suppress flag.
      let cfg: TodoConfig | undefined;
      try { cfg = loadConfig(); } catch { /* config optional */ }
      let autoMsg = "";
      let ageDays = cfg?.prune.defaultAgeDays ?? 7;
      try {
        const ap = autoPruneOnSessionStart();
        if (ap) {
          const lines = ap.items.map((i) => `  [${i.id}] ${i.status}  ${i.title}`);
          autoMsg = ` · auto-pruned ${ap.moved} stale done (>${ageDays}d):\n${lines.join("\n")}\nUndo any with: todo restore <id>`;
        }
      } catch {
        // auto-prune optional — don't crash the session notify
      }
      // v0.6.0: source-aware stale-active reap runs AFTER auto-prune. Reaped
      // todos enter the archive as cancelled (immediately restorable), never deleted.
      let reapMsg = "";
      try {
        const rp = reapStaleActive();
        if (rp) {
          const shownIds = rp.ids.slice(0, 5).map((id) => `[${id}]`).join(" ");
          const more = rp.ids.length > 5 ? ` +${rp.ids.length - 5} more` : "";
          reapMsg = ` · ♻ reaped ${rp.reaped} stale ${rp.reaped === 1 ? "run" : "runs"} (oldest ${rp.oldestDays}d) · ${shownIds}${more} — restore via \`todo restore <id>\``;
        }
      } catch {
        // reap optional — never crash the session notify
      }
      const showCount = cfg?.notify?.sessionStartCount !== false;
      const open = listTodos();
      let msg = "";
      if (showCount) {
        msg = `armory-todo: ${open.length} open TODO${open.length === 1 ? "" : "s"}${autoMsg}${reapMsg}`;
        try {
          const report = healthReport();
          if (report.flags.length > 0) {
            msg += `${autoMsg ? "\n" : " — "}` + `⚠ ${report.flags.length} bloat signal${report.flags.length === 1 ? "" : "s"} (run /todo health)`;
          }
          if (report.orphan.count > 0) {
            msg += ` · ${report.orphan.count} orphaned (oldest ${report.orphan.oldestDays}d untouched, non-policy — review in /todo)`;
          }
        } catch {
          // health check optional
        }
      } else if (autoMsg || reapMsg) {
        // Count line suppressed; still surface auto-prune/reap safety messages.
        msg = `armory-todo${autoMsg}${reapMsg}`;
      }
      if (ctx.hasUI) {
        const out = (wipeMsg ? wipeMsg + "\n" : "") + msg;
        if (out) ctx.ui.notify(out, "info");
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
      "Use when the user says 'put this in our TODO', 'show me the TODO', 'mark <id> done', 'park <id>', 'prune', 'restore <id>', 'how is my todo hygiene?', etc. " +
      "Open TODOs are auto-injected each turn; parked todos are NOT injected (deferred/someday). " +
      "Done/cancelled todos are moved to an archive by `prune` (reversible via `restore`). " +
      "`prune --hard` (hard:true, confirm:true) is the ONLY irreversible action — always run `health` first, surface the report + proposed command, and wait for explicit user confirmation. " +
      "Never put secrets in a TODO — the text reaches the model provider.",
    promptSnippet: "Read/update the global cross-session TODO list (active / parked / archive) + bloat health",
    promptGuidelines: [
      "Use todo (action:'add', title, notes?, project?, tags?, priority?, source?) when the user says 'put this in our TODO'. title max 120 chars (one-line summary); put long detail in notes (capped at health.maxNotesBytes, default 8KB — oversize is rejected at write). Adds are BLOCKED if the target project is at its per-project maxOpen cap (the slot you set via the Projects tab); close/park one or raise maxOpen first.",
      "Use todo (action:'get', id) to read a todo's full notes before acting on it (the bullet marker in lists means notes exist).",
      "Use todo (action:'update', id, title?, notes?, project?, tags?, priority?, status?) to edit; notes empty string clears.",
      "Use todo (action:'list') when the user asks 'show me the TODO' / 'what's pending' (text filter searches title+notes).",
      "Use todo (action:'complete', id) to mark a TODO done; (action:'delete', id) to cancel it.",
      "Use todo (action:'park', id) to defer a TODO (not injected, recoverable); (action:'update', id, status:'open') to un-park.",
      "Use todo (action:'prune') to move done/cancelled todos to the archive (reversible); (action:'prune', all:true) to prune all regardless of age.",
      "Done/cancelled todos older than the prune age (default 7d) auto-archive on session start — you'll see a notify; reversible via todo restore <id>. Use /todo finished or todo list status:'done' to see all finished work (live + archived).",
      "Use todo (action:'restore', id) to bring an archived TODO back as open.",
      "Use todo (action:'list', archived:true) to query the archive; bare call returns a summary, add a filter (project/text/since) for specific items.",
      "Use todo (action:'health') to check bloat across all boxes (counts + flags + suggestions). Run when the user asks about hygiene/bloat or before any hard-prune.",
      "Use todo (action:'prune', hard:true, confirm:true, box?, olderThan?) for PERMANENT deletion (the only irreversible action). ALWAYS run health first, show the user the report + the exact proposed command, and wait for an explicit yes before passing confirm:true. Never hard-prune without explicit user confirmation.",
      "Use todo (action:'projects') for a per-project scope overview (open/in_progress/parked/done counts + maxOpen + OVER/?typo markers). Run when the user asks 'which projects have open work' or to see backlog shape by project.",
      "Use todo (action:'project_rename', oldName, newName) to rename or merge a project (rewrites live + archive + registry). Use it to fix typo'd project strings (e.g. foo-bat → foo-bar). Rename onto an existing name merges (consolidates the old project into the new). Per-project maxOpen caps are ENFORCED (block-on-add); they also drive a PROJECT_OVER health flag when breached.",
      "Use todo (action:'triage') for agent-validated pruning: phase 1 gathers candidates (stale 30d + orphans 14d + over-cap projects + agent-source debris) and returns them with the versioned rubric — NOTHING mutates. Validate each candidate with read-only probes (git log / gh / npm view), present the proposal table (verdict + evidence + confidence), get ONE batch approval from the user, then call phase 2: todo(action:'triage', approve:[{id, verdict:'close'|'park'|'keep', reason?, evidence?, confidence?, survivorId?}]). Closed items are archived (reversible) and filed as CLOSED issues in the private getpipher/todo-ledger. autoSafe:true (--yes) executes ONLY the mechanical safe class (fleet-run prompt debris) — never auto-close anything you could not verify (zero false-closes). Scope with scope:'<project>'.",
    ],
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      id: Type.Optional(Type.String({ description: "Todo id (for update/complete/delete/park/restore/get)" })),
      title: Type.Optional(Type.String({ description: "Todo title (add required; update optional). Max 120 chars; put detail in notes." })),
      notes: Type.Optional(Type.String({ description: "Todo notes/body (add/update optional; long-form, not injected). Pass empty string on update to clear." })),
      text: Type.Optional(Type.String({ description: "Search query (list only). Substring match on title OR notes. Not used by add/update." })),
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
      // hard-prune options (SPEC-2)
      hard: Type.Optional(Type.Boolean({ description: "prune: if true, execute a HARD prune (permanent deletion). Requires confirm:true. The only irreversible action." })),
      confirm: Type.Optional(Type.Boolean({ description: "hard-prune: must be true to execute. Always surface the health report + proposed command and wait for explicit user confirmation first." })),
      box: Type.Optional(StringEnum(["archive", "active", "parked"] as const, { description: "hard-prune: which box to target (default archive)" })),
      olderThan: Type.Optional(Type.Number({ description: "hard-prune: delete items older than this many days (by closedAt for archive, updatedAt for active/parked)" })),
      // project actions (v0.4.0)
      oldName: Type.Optional(Type.String({ description: "project_rename: current project name" })),
      newName: Type.Optional(Type.String({ description: "project_rename: new project name (merge if it already exists)" })),
      // triage (PRD 2026-08-30) — two phases within one action:
      //   phase 1 (no approve): gather candidates + return the versioned rubric. NOTHING mutates.
      //   phase 2 (approve): execute exactly the approved decisions, then file closed items to the ledger.
      scope: Type.Optional(Type.String({ description: "triage: restrict candidates to one project name (empty = all)" })),
      autoSafe: Type.Optional(Type.Boolean({ description: "triage (--yes): auto-execute ONLY the mechanical safe class (fleet-run prompt debris). Everything else stays a proposal — never auto-closed (D2)." })),
      approve: Type.Optional(Type.Array(Type.Object({
        id: Type.String({ description: "Candidate todo id (td-…)" }),
        verdict: StringEnum(["close", "park", "keep"] as const),
        reason: Type.Optional(Type.String({ description: "close only: debris | duplicate | stale-unverified | verified-shipped" })),
        evidence: Type.Optional(Type.String({ description: "One CHECKED line (git/gh/npm probe result). Required for verified-shipped closes." })),
        confidence: Type.Optional(StringEnum(["high", "medium", "low"] as const)),
        survivorId: Type.Optional(Type.String({ description: "duplicate closes: the surviving todo id" })),
      }), { description: "triage phase 2: the user-approved decisions. Executes exactly these; nothing else." })),
    }),
    async execute(_toolCallId, params) {
      try {
        switch (params.action) {
          case "list": {
            if (params.status === "done" && !params.archived) {
              const items = listDoneUnified({
                text: params.text,
                project: params.projectFilter,
                since: params.since,
                before: params.before,
                limit: params.limit,
                page: params.page,
              });
              if (items.length === 0) {
                return { content: [{ type: "text" as const, text: "No done TODOs (live or archive)." }] };
              }
              return { content: [{ type: "text" as const, text: `Done (${items.length}):\n${items.map(fmtDone).join("\n")}` }] };
            }
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
            if (!params.title) {
              return { content: [{ type: "text" as const, text: "Error: `title` is required for add." }] };
            }
            const t = addTodo({
              title: params.title,
              notes: params.notes,
              project: params.project,
              tags: params.tags,
              priority: params.priority as any,
              source: params.source as any,
            });
            return { content: [{ type: "text" as const, text: `Added ${t.id}: ${t.title}` }] };
          }
          case "update": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for update." }] };
            const t = updateTodo(params.id, {
              title: params.title,
              notes: params.notes,
              project: params.project,
              tags: params.tags,
              priority: params.priority as any,
              status: params.status as any,
            });
            return { content: [{ type: "text" as const, text: `Updated ${t.id}: ${t.title} [${t.status}]` }] };
          }
          case "get": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for get." }] };
            const t = getTodo(params.id);
            return { content: [{ type: "text" as const, text: fmtFull(t) }] };
          }
          case "complete": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for complete." }] };
            const t = completeTodo(params.id);
            return { content: [{ type: "text" as const, text: `Completed ${t.id}: ${t.title}` }] };
          }
          case "delete": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for delete." }] };
            const t = deleteTodo(params.id);
            return { content: [{ type: "text" as const, text: `Cancelled ${t.id}: ${t.title}` }] };
          }
          case "park": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for park." }] };
            const t = parkTodo(params.id);
            return { content: [{ type: "text" as const, text: `Parked ${t.id}: ${t.title}` }] };
          }
          case "prune": {
            if (params.hard) {
              const res = hardPrune({
                confirm: params.confirm === true,
                box: params.box,
                olderThan: params.olderThan,
                project: params.projectFilter,
                tag: params.tagFilter,
              });
              return { content: [{ type: "text" as const, text: res.message + (res.refused ? "" : ` Deleted: ${res.ids.join(", ") || "(none)"}`) }] };
            }
            const res = pruneTodos({ ageDays: params.ageDays, all: params.all });
            if (res.moved === 0) {
              return { content: [{ type: "text" as const, text: "Nothing to prune (no stale done/cancelled)." }] };
            }
            const prunedLines = res.items.map((i) => `  [${i.id}] ${i.status}  ${i.title}  (was ${i.ageDays}d old)`);
            return { content: [{ type: "text" as const, text: `Pruned ${res.moved} todo${res.moved === 1 ? "" : "s"} to archive:\n${prunedLines.join("\n")}\nUndo any with: todo restore <id>` }] };
          }
          case "health": {
            const report = healthReport();
            const projLines = report.projects.length
              ? [`projects:`, ...report.projects.map((p) => {
                  const cap = p.maxOpen !== null ? ` [max:${p.maxOpen}]` : "";
                  const flags = [p.over && "OVER", p.large && "LARGE", p.stale && "STALE", p.typo && "TYPO"].filter(Boolean).join(" ");
                  return `  ${p.name}  ${p.open} open${cap}${flags ? ` ${flags}` : ""}`;
                })]
              : [];
            const lines = [
              `## TODO Health Report`,
              `active:  ${report.active.open} open + ${report.active.in_progress} in_progress (${report.active.stale_30d} stale)`,
              `parked:  ${report.parked.count} (${report.parked.stale_60d} stale)`,
              `archive: ${report.archive.count} (${report.archive.older_180d} old)`,
              `notes:   ${report.notesBytes.total}B total · max ${report.notesBytes.max}B · avg ${report.notesBytes.avg}B`,
              `(no project): ${report.noProject.open} open`,
              report.flags.length ? `flags: ${report.flags.join(", ")}` : "flags: (none — healthy)",
              ...projLines,
              ...report.suggestions.map((s) => `  → ${s}`),
            ];
            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          }
          case "restore": {
            if (!params.id) return { content: [{ type: "text" as const, text: "Error: `id` is required for restore." }] };
            const t = restoreTodo(params.id);
            return { content: [{ type: "text" as const, text: `Restored ${t.id}: ${t.title} [open]` }] };
          }
          case "clear": {
            const n = clearTodos((params.status as any) ?? "done");
            return { content: [{ type: "text" as const, text: `Cleared ${n} '${params.status ?? "done"}' TODOs.` }] };
          }
          case "projects": {
            const o = projectsOverview();
            const rows = o.rows.map((r) => {
              const cap = r.maxOpen !== null ? ` [max:${r.maxOpen}]` : "";
              const over = r.over ? " OVER" : "";
              const typo = r.typo ? " ?typo" : "";
              return `  ${r.name}  ${r.open}o/${r.in_progress}i/${r.parked}p/${r.done}d (total ${r.total})${cap}${over}${typo}`;
            });
            const np = `(no project): ${o.noProject.count} total · ${o.noProject.open} open`;
            const text = rows.length ? `Projects (${o.rows.length}):\n${rows.join("\n")}\n${np}` : `Projects: (none)\n${np}`;
            return { content: [{ type: "text" as const, text }] };
          }
          case "project_rename": {
            if (!params.oldName || !params.newName) {
              return { content: [{ type: "text" as const, text: "Error: `oldName` and `newName` are required for project_rename." }] };
            }
            const r = renameProject(params.oldName, params.newName);
            return { content: [{ type: "text" as const, text: `Renamed ${params.oldName} → ${r.newName}: ${r.liveRenamed} live + ${r.archivedRenamed} archived${r.merged ? " (merged)" : ""}` }] };
          }
          case "triage": {
            // Phase 2: execute exactly the user-approved decisions (D2 gate).
            if (params.approve?.length) {
              const before = gatherCandidates(params.scope).before;
              const report = await executeTriage(params.approve as TriageDecision[]);
              return { content: [{ type: "text" as const, text: renderReport(report, before) }] };
            }
            // Phase 1: gather + propose. NOTHING mutates unless autoSafe (--yes),
            // which executes ONLY the mechanical safe class (fleet-run debris).
            let safeMsg = "";
            if (params.autoSafe) {
              const { report, remaining } = await executeSafeClass(params.scope);
              safeMsg = report
                ? `--yes executed the safe class ONLY (fleet-run debris). Everything else needs the batch approval.\n\n${renderReport(report)}\n`
                : "--yes: no mechanical-safe debris found — nothing auto-closed.\n";
              if (report && remaining === 0) {
                return { content: [{ type: "text" as const, text: safeMsg + "No remaining candidates — triage complete." }] };
              }
            }
            const g = gatherCandidates(params.scope);
            if (g.candidates.length === 0) {
              return { content: [{ type: "text" as const, text: `${safeMsg}${safeMsg ? "\n" : ""}Triage: no candidates (before: ${g.before.active} active / ${g.before.parked} parked / ${g.before.archive} archive${g.scope ? `, scope: ${g.scope}` : ""}). Nothing to propose, nothing mutated.` }] };
            }
            const lines = [
              `## Triage — proposal (NOTHING mutated yet)`,
              `before: ${g.before.active} active / ${g.before.parked} parked / ${g.before.archive} archive${g.scope ? ` · scope: ${g.scope}` : ""} · candidates: ${g.candidates.length} · rubric ${TRIAGE_PROMPT_VERSION}`,
              "",
              renderProposalTable(g),
              "",
              safeMsg,
              `Validate each candidate against the rubric below (read-only probes: git log, gh, npm view — checked, not guessed). Then present the proposal table (verdict + evidence + confidence) to the user and get ONE batch approval. On approval execute all decisions in a single call:`,
              `  todo(action:"triage", approve:[{ id, verdict:"close"|"park"|"keep", reason?, evidence?, confidence?, survivorId? }, ...])`,
              `Safety: close needs reason (debris|duplicate|stale-unverified|verified-shipped); duplicate needs survivorId; verified-shipped needs evidence. Items you cannot verify stay proposals — zero false-closes is the metric. The safe-class column marks what --yes may close WITHOUT approval.`,
              "",
              buildTriagePrompt(g.candidates, g.scope),
            ];
            return { content: [{ type: "text" as const, text: lines.filter((l) => l !== "").join("\n") }] };
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
      "/todo / /todo all / /todo add <title> / /todo done <id> / /todo rm <id> / " +
      "/todo park <id> / /todo restore <id> / /todo prune [--all|--hard --box <b> --older-than <d>] / " +
      "/todo archive [project:X|text:Y] / /todo finished / /todo projects / /todo health / /todo triage [scope] [--yes] / /todo clean / /todo path",
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
          const title = rest.join(" ").trim();
          if (!title) { if (ctx.hasUI) ctx.ui.notify("usage: /todo add <title>  (notes via the todo tool)", "warning"); return; }
          const t = addTodo({ title, source: "slash" });
          if (ctx.hasUI) ctx.ui.notify(`Added ${t.id}: ${t.title}`, "info");
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
          if (ctx.hasUI) ctx.ui.notify(`Parked ${t.id}: ${t.title}`, "info");
          return;
        }
        if (sub === "restore") {
          const id = rest[0];
          if (!id) { if (ctx.hasUI) ctx.ui.notify("usage: /todo restore <id>", "warning"); return; }
          const t = restoreTodo(id);
          if (ctx.hasUI) ctx.ui.notify(`Restored ${t.id}: ${t.title}`, "info");
          return;
        }
        if (sub === "prune") {
          const isHard = rest.includes("--hard");
          if (isHard) {
            const boxIdx = rest.indexOf("--box");
            const olderIdx = rest.indexOf("--older-than");
            const projIdx = rest.indexOf("--project");
            const box = boxIdx >= 0 ? rest[boxIdx + 1] : undefined;
            const olderThan = olderIdx >= 0 ? Number(rest[olderIdx + 1]) : undefined;
            const project = projIdx >= 0 ? rest[projIdx + 1] : undefined;
            const preview = hardPrune({ confirm: false, box: box as any, olderThan, project });
            if (ctx.hasUI) {
              const yes = await ctx.ui.confirm(
                "Hard Prune",
                `HARD PRUNE (permanent deletion)\n${preview.message}\nBox: ${box ?? "archive"}${olderThan ? `, older than ${olderThan}d` : ""}${project ? `, project: ${project}` : ""}\n\nProceed?`,
              );
              if (!yes) { ctx.ui.notify("Hard-prune cancelled.", "info"); return; }
            }
            const res = hardPrune({ confirm: true, box: box as any, olderThan, project });
            if (ctx.hasUI) ctx.ui.notify(res.message + ` Deleted: ${res.ids.join(", ") || "(none)"}`, res.refused ? "warning" : "info");
            return;
          }
          const all = rest.includes("--all");
          const res = pruneTodos({ all });
          if (ctx.hasUI) {
            const msg = res.moved === 0
              ? "Nothing to prune."
              : `Pruned ${res.moved} to archive:\n${res.items.map((i) => `  [${i.id}] ${i.title} (${i.ageDays}d)`).join("\n")}\nUndo: todo restore <id>`;
            ctx.ui.notify(msg, "info");
          }
          return;
        }
        if (sub === "triage") {
          // Thin mirror of todo(action:'triage') — humans get the proposal table;
          // the validation loop runs through the agent (rubric ships in-package).
          const yes = rest.includes("--yes");
          const scopeArg = rest.find((r) => !r.startsWith("--"));
          let safeMsg = "";
          if (yes) {
            const { report, remaining } = await executeSafeClass(scopeArg);
            safeMsg = report ? renderReport(report) + `\nremaining candidates: ${remaining}\n` : "--yes: no mechanical-safe debris — nothing auto-closed.\n";
          }
          const g = gatherCandidates(scopeArg);
          const head = `Triage (before: ${g.before.active} active / ${g.before.parked} parked / ${g.before.archive} archive${scopeArg ? `, scope: ${scopeArg}` : ""})`;
          if (g.candidates.length === 0) {
            if (ctx.hasUI) ctx.ui.notify(`${head}\n${safeMsg || "No candidates — nothing to propose, nothing mutated."}`, "info");
            return;
          }
          const msg = [
            head,
            safeMsg,
            `candidates (${g.candidates.length}) — NOTHING mutated${yes ? " beyond the safe class above" : ""}:`,
            renderProposalTable(g),
            "",
            `Ask the agent to validate these against the triage rubric (${TRIAGE_PROMPT_VERSION}) using read-only probes, then approve the batch. The agent executes via todo(action:"triage", approve:[…]); closed items are filed to ${"getpipher/todo-ledger"} (private).`,
          ].filter((l) => l !== "").join("\n");
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          return;
        }
        if (sub === "health") {
          const report = healthReport();
          const projLines = report.projects.length
            ? [`  projects:`, ...report.projects.map((p) => {
                const cap = p.maxOpen !== null ? ` [max:${p.maxOpen}]` : "";
                const flags = [p.over && "OVER", p.large && "LARGE", p.stale && "STALE", p.typo && "TYPO"].filter(Boolean).join(" ");
                return `    ${p.name}  ${p.open} open${cap}${flags ? ` ${flags}` : ""}`;
              })]
            : [];
          const lines = [
            `TODO Health:`,
            `  active:  ${report.active.open} open + ${report.active.in_progress} in_progress (${report.active.stale_30d} stale)`,
            `  parked:  ${report.parked.count} (${report.parked.stale_60d} stale)`,
            `  archive: ${report.archive.count} (${report.archive.older_180d} old)`,
            `  notes:   ${report.notesBytes.total}B total · max ${report.notesBytes.max}B · avg ${report.notesBytes.avg}B`,
            `  (no project): ${report.noProject.open} open`,
            report.flags.length ? `  ⚠ ${report.flags.join(", ")}` : "  ✅ healthy",
            ...projLines,
            ...report.suggestions.map((s) => `  → ${s}`),
          ];
          if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
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
        if (sub === "finished") {
          const items = listDoneUnified({ text: rest.join(" ").trim() || undefined, limit: 100 });
          const msg = items.length ? `Done (${items.length}):\n${items.map(fmtDone).join("\n")}` : "(no done TODOs)";
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
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
        if (sub === "projects") {
          const o = projectsOverview();
          const rows = o.rows.map((r) => {
            const cap = r.maxOpen !== null ? ` [max:${r.maxOpen}]` : "";
            const over = r.over ? " OVER" : "";
            const typo = r.typo ? " ?typo" : "";
            return `  ${r.name}  ${r.open}o/${r.in_progress}i/${r.parked}p/${r.done}d (total ${r.total})${cap}${over}${typo}`;
          });
          const np = `(no project): ${o.noProject.count} total · ${o.noProject.open} open`;
          const msg = rows.length ? `Projects (${o.rows.length}):\n${rows.join("\n")}\n${np}` : `Projects: (none)\n${np}`;
          if (ctx.hasUI) ctx.ui.notify(msg, "info");
          return;
        }
        // default: open the interactive panel (TUI) or list open (non-TUI)
        if (ctx.mode === "tui") {
          await ctx.ui.custom<boolean>((_tui, theme, _kb, done) => {
            const panel = new TodoPanel({
              theme: theme as any,
              onDone: () => done(true),
              onNotify: (msg, type) => ctx.ui.notify(msg, type ?? "info"),
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
      } catch (err) {
        if (ctx.hasUI) ctx.ui.notify(`todo error: ${(err as Error).message}`, "warning");
      }
    },
  });
}
