// /todo triage engine (PRD: agent-validated pruning + GH ledger) — v1 thin slice.
//
// Pipeline: GATHER -> VALIDATE (agent, rubric in triage-prompt.ts) -> PROPOSE
// -> APPROVE (batch) -> EXECUTE (cancel/park/keep + prune --all sweep) -> FILE
// (private ledger repo, idempotent, non-blocking) -> REPORT.
//
// Composition rules (PRD "Non-goals" + repo conventions):
//   - Staleness thresholds come from the EXISTING config: health.activeStaleDays
//     (30d) and reap.orphanFlagAfterDays (14d). No new config knobs, no
//     duplicated semantics.
//   - in_progress todos are NEVER candidates (D3: fresh/in_progress/policy-source
//     stay untouched). Policy auto-reap sources are owned by reap.ts — triage
//     never treats them as mechanical debris.
//   - D2: nothing mutates before a batch approval — except --yes, which executes
//     ONLY the mechanical safe class (fleet-run prompt debris). Everything else,
//     including verified-shipped closes, goes through `approve`.
//   - D4: ledger filing is idempotent (search "td-<id> in:title" first, issues
//     are created CLOSED) and NEVER blocking — a gh failure archives locally
//     and is reported as skipped. The gh runner is dependency-injected so tests
//     stay hermetic (no network, no live store).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadStore, updateTodo, type Todo } from "./todo-store.ts";
import { loadArchive, pruneTodos } from "./archive.ts";
import { loadConfig } from "./config.ts";
import { loadRegistry } from "./registry.ts";
import { overBudgetProjects } from "./caps.ts";

const execFileP = promisify(execFile);

const DAY = 86_400_000;

/** Private ledger repo (D4 — TODO notes are sensitive; never a public repo).
 *  Production default: getpipher/todo-ledger. TODO_LEDGER_REPO env override
 *  exists for scratch/manual runs against a throwaway repo — resolved at call
 *  time so a long-lived session picks it up. */
export const TRIAGE_LEDGER_REPO_DEFAULT = "getpipher/todo-ledger";
export function ledgerRepo(): string {
  return process.env.TODO_LEDGER_REPO || TRIAGE_LEDGER_REPO_DEFAULT;
}

// ---------------------------------------------------------------------------
// Types

export type TriageVerdict = "close" | "park" | "keep";
export type CloseReason = "debris" | "duplicate" | "stale-unverified" | "verified-shipped";
export type Confidence = "high" | "medium" | "low";

export type GhRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface Candidate {
  todo: Todo;
  /** Which gather categories matched: stale-30d / orphan-14d / agent-source / over-cap-project. */
  categories: string[];
  /** Age by updatedAt, whole days down. */
  ageDays: number;
  /** Mechanical safe class (D2 --yes): fleet-run prompt debris, closable without judgment. */
  mechanicalSafe: boolean;
}

export interface GatherResult {
  scope?: string;
  before: { active: number; parked: number; archive: number };
  candidates: Candidate[];
  overCapProjects: { name: string; open: number; maxOpen: number }[];
  staleDays: number;
  orphanDays: number;
}

export interface TriageDecision {
  id: string;
  verdict: TriageVerdict;
  reason?: CloseReason;
  evidence?: string;
  confidence?: Confidence;
  /** duplicate closes: the todo that survives. */
  survivorId?: string;
}

export interface LedgerFiling {
  id: string;
  status: "filed" | "skipped-existing" | "skipped-gh-error" | "skipped-duplicate-id";
  url?: string;
  error?: string;
}

export interface TriageReport {
  closed: { id: string; title: string; project: string }[];
  parked: { id: string; title: string; project: string }[];
  kept: { id: string; title: string }[];
  /** Items rejected before any mutation (bad id, not open, invalid decision). */
  rejected: { id: string; error: string }[];
  pruned: number;
  filings: LedgerFiling[];
  after: { active: number; parked: number; archive: number };
}

export interface TriageOptions {
  /** Dependency-injected gh runner (tests). Default: real `gh` CLI. */
  gh?: GhRunner;
  /** Skip ledger filing entirely (hermetic runs that must not touch gh).
  *  Also honored via TODO_TRIAGE_SKIP_FILING=1 (air-gapped / offline runs —
  *  D4: pruning must never depend on the network). */
  skipFiling?: boolean;
}

// ---------------------------------------------------------------------------
// Gather (pure read — no mutation, no config writes)

/** Prompt-shaped title: fleet runs auto-track subagent PROMPTS as titles
 *  ("You are COMPLETING Task 9: ...", "[general-purpose] You are ...").
 *  Deliberately narrow — a human-written title rarely starts this way, and
 *  zero false-closes is the success metric. */
export function isPromptShapedTitle(title: string): boolean {
  return /^you (are|'re|will|r)\b/i.test(title) || /^\[[\w.-]+\]\s/.test(title);
}

/** Agent context: a source/project/tag that names an agent-run producer.
 *  Reap-policy sources are excluded upstream — reap.ts owns those. */
function hasAgentContext(todo: Todo): boolean {
  const hay = [todo.source, todo.project, ...todo.tags].join(" ").toLowerCase();
  return /\b(fleet|agent|subagent|run)\b/.test(hay);
}

/** Mechanical safe class (D2 --yes): prompt-shaped debris with agent context.
 *  Policy auto-reap sources never qualify — reap.ts already owns them. */
export function isMechanicalSafe(todo: Todo, policySources: Set<string>): boolean {
  if (todo.status !== "open") return false;
  if (policySources.has(todo.source)) return false;
  return isPromptShapedTitle(todo.title) && hasAgentContext(todo);
}

/** GATHER: stale(30d) + orphans(14d) + over-cap projects + agent-source items.
 *  Pure read: loads store/config/registry, mutates nothing, persists nothing. */
export function gatherCandidates(scope?: string): GatherResult {
  const config = loadConfig();
  const staleDays = config.health.activeStaleDays;
  const orphanDays = config.reap.orphanFlagAfterDays;
  const policySources = new Set(Object.keys(config.reap.policy));

  const store = loadStore();
  const archiveCount = loadArchive().todos.length;
  const active = store.todos.filter((t) => t.status === "open" || t.status === "in_progress");
  const parked = store.todos.filter((t) => t.status === "parked");

  // Over-cap projects (advisory registry caps — same definition as health PROJECT_OVER).
  const registry = loadRegistry();
  const overCap = overBudgetProjects(store.todos, registry);

  const now = Date.now();
  const candidates: Candidate[] = [];

  for (const todo of store.todos) {
    if (todo.status !== "open") continue; // D3: in_progress/parked/terminal — untouched
    if (policySources.has(todo.source)) continue; // D3: policy-source — reap.ts owns them
    if (scope && todo.project !== scope) continue;

    const ageDays = Math.floor((now - Date.parse(todo.updatedAt)) / DAY);
    const categories: string[] = [];
    if (ageDays > staleDays) categories.push("stale-30d");
    if (!policySources.has(todo.source) && ageDays >= orphanDays) categories.push("orphan-14d");
    if (hasAgentContext(todo) && ageDays >= orphanDays) categories.push("agent-source");
    if (overCap.some((p) => p.name === todo.project && todo.status === "open")) categories.push("over-cap-project");
    if (categories.length === 0) continue;

    candidates.push({ todo, categories, ageDays, mechanicalSafe: isMechanicalSafe(todo, policySources) });
  }

  return {
    scope,
    before: { active: active.length, parked: parked.length, archive: archiveCount },
    candidates,
    overCapProjects: overCap,
    staleDays,
    orphanDays,
  };
}

// ---------------------------------------------------------------------------
// Execute (the ONLY mutation path — behind an explicit decision list)

const CLOSE_REASONS: CloseReason[] = ["debris", "duplicate", "stale-unverified", "verified-shipped"];

function validateDecisions(decisions: TriageDecision[]): { id: string; error: string }[] {
  const errors: { id: string; error: string }[] = [];
  decisions.forEach((d, i) => {
    const label = d.id || `decisions[${i}]`;
    if (!d.verdict || !["close", "park", "keep"].includes(d.verdict)) {
      errors.push({ id: label, error: `invalid verdict "${String(d.verdict)}" (close|park|keep)` });
      return;
    }
    if (d.verdict === "close") {
      if (!d.reason || !CLOSE_REASONS.includes(d.reason)) {
        errors.push({ id: label, error: `close requires reason (${CLOSE_REASONS.join("|")})` });
        return;
      }
      if (d.reason === "duplicate" && !d.survivorId) {
        errors.push({ id: label, error: `duplicate close requires survivorId` });
        return;
      }
      if (d.reason === "verified-shipped" && !d.evidence) {
        errors.push({ id: label, error: `verified-shipped close requires evidence` });
        return;
      }
    }
  });
  return errors;
}

/** EXECUTE + FILE + REPORT (PRD pipeline steps 5-7).
 *
 *  Mutates exactly the approved decisions: close -> cancelled, park -> parked,
 *  keep -> untouched. Then one `prune --all` sweep (closed items enter the
 *  archive — reversible), then ledger filing for the closed set (idempotent,
 *  never blocking), then the before/after report. Snapshots are taken BEFORE
 *  mutation so filing carries the full original note even after the sweep.
 *
 *  Per-item rejections (unknown id, not open, malformed decision) never abort
 *  the batch — they land in `rejected` and the rest executes. */
export async function executeTriage(decisions: TriageDecision[], opts: TriageOptions = {}): Promise<TriageReport> {
  const rejected = validateDecisions(decisions);
  const rejectedIds = new Set(rejected.map((r) => r.id));

  const store = loadStore();
  const before = {
    active: store.todos.filter((t) => t.status === "open" || t.status === "in_progress").length,
    parked: store.todos.filter((t) => t.status === "parked").length,
    archive: loadArchive().todos.length,
  };

  const closed: TriageReport["closed"] = [];
  const parked: TriageReport["parked"] = [];
  const kept: TriageReport["kept"] = [];
  const snapshots = new Map<string, Todo>();

  for (const d of decisions) {
    if (rejectedIds.has(d.id)) continue;
    const todo = loadStore().todos.find((t) => t.id === d.id);
    if (!todo) {
      rejected.push({ id: d.id, error: `no todo with id ${d.id}` });
      continue;
    }
    if (todo.status !== "open") {
      rejected.push({ id: d.id, error: `not open (status: ${todo.status}) — triage only rules on open items` });
      continue;
    }
    if (d.verdict === "keep") {
      kept.push({ id: d.id, title: todo.title });
      continue;
    }
    // Snapshot before mutation — filing needs the full original record.
    snapshots.set(d.id, { ...todo });
    if (d.verdict === "close") {
      updateTodo(d.id, { status: "cancelled" });
      closed.push({ id: d.id, title: todo.title, project: todo.project });
    } else {
      updateTodo(d.id, { status: "parked" });
      parked.push({ id: d.id, title: todo.title, project: todo.project });
    }
  }

  // Reversible sweep: everything terminal in the live store enters the archive.
  let pruned = 0;
  if (closed.length > 0) {
    pruned = pruneTodos({ all: true }).moved;
  }

  // FILE — closed items only, idempotent, never blocking (D4).
  const filings: LedgerFiling[] = [];
  if (closed.length > 0 && !opts.skipFiling && process.env.TODO_TRIAGE_SKIP_FILING !== "1") {
    const gh = opts.gh ?? defaultGhRunner;
    for (const item of closed) {
      const snapshot = snapshots.get(item.id)!;
      const decision = decisions.find((d) => d.id === item.id)!;
      filings.push(await fileClosedTodo(gh, snapshot, decision));
    }
  }

  const afterStore = loadStore();
  const after = {
    active: afterStore.todos.filter((t) => t.status === "open" || t.status === "in_progress").length,
    parked: afterStore.todos.filter((t) => t.status === "parked").length,
    archive: loadArchive().todos.length,
  };

  return { closed, parked, kept, rejected, pruned, filings, after };
}

/** --yes path (D2): execute ONLY the mechanical safe class. Everything else
 *  stays a proposal. Scope-filtered when a scope is given. Returns the report
 *  plus the remaining (unexecuted) candidate count. */
export async function executeSafeClass(scope?: string, opts: TriageOptions = {}): Promise<{ report: TriageReport | null; remaining: number }> {
  const gather = gatherCandidates(scope);
  const policySources = new Set(Object.keys(loadConfig().reap.policy));
  const safe = gather.candidates.filter((c) => isMechanicalSafe(c.todo, policySources));
  if (safe.length === 0) return { report: null, remaining: gather.candidates.length };
  const decisions: TriageDecision[] = safe.map((c) => ({
    id: c.todo.id,
    verdict: "close",
    reason: "debris",
    evidence: "mechanical: fleet-run prompt debris (prompt-shaped title + agent context)",
    confidence: "high",
  }));
  const report = await executeTriage(decisions, opts);
  return { report, remaining: gather.candidates.length - safe.length };
}

// ---------------------------------------------------------------------------
// Ledger filing (D4: private repo, idempotent, created CLOSED, never blocking)

export const defaultGhRunner: GhRunner = async (args) => {
  try {
    const { stdout, stderr } = await execFileP("gh", args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message };
  }
};

function projectLabel(project: string): string {
  return `project/${project.trim().replace(/\s+/g, "-").toLowerCase() || "none"}`;
}

/** Make sure the ledger repo exists (private). Returns null when usable,
 *  or an error string when gh cannot see/create it (caller skips filing). */
export async function ensureLedgerRepo(gh: GhRunner): Promise<string | null> {
  const view = await gh(["repo", "view", ledgerRepo(), "--json", "name,visibility"]);
  if (view.code === 0) return null;
  const create = await gh(["repo", "create", ledgerRepo(), "--private"]);
  if (create.code !== 0) {
    return `gh cannot see or create ${ledgerRepo()}: ${(create.stderr || view.stderr).trim().slice(0, 200)}`;
  }
  return null;
}

/** Idempotency probe: an existing issue titled with this td-<id> short-circuits creation.
 *  Client-side title match on a full list — deliberately NOT `--search`, which
 *  rides GitHub's search index and LAGS fresh issues (proven in smoke: a
 *  same-second re-file sailed past the probe and created a duplicate). */
export async function findLedgerIssue(gh: GhRunner, id: string): Promise<string | null> {
  const res = await gh([
    "issue", "list", "-R", ledgerRepo(),
    "--state", "all", "--json", "number,title,url", "--limit", "1000",
  ]);
  if (res.code !== 0) return null; // probe failure -> fall through to create attempt; create failing is what skips
  try {
    const found = (JSON.parse(res.stdout) as { title: string; url: string }[]).filter((i) => i.title.includes(id));
    return found.length > 0 ? found[0].url : null;
  } catch {
    return null;
  }
}

function ledgerBody(todo: Todo, decision: TriageDecision): string {
  return [
    `## Archived TODO \`${todo.id}\``,
    "",
    `- **project:** ${todo.project || "(none)"}`,
    `- **closed:** ${todo.closedAt ?? "(unknown)"} as \`${todo.status}\``,
    `- **close reason:** ${decision.reason ?? "(unspecified)"}`,
    `- **confidence:** ${decision.confidence ?? "(unspecified)"}`,
    `- **evidence:** ${decision.evidence || "(none recorded)"}`,
    decision.survivorId ? `- **duplicate of:** \`${decision.survivorId}\`` : "",
    "",
    "### Original title",
    "",
    todo.title,
    "",
    "### Original notes",
    "",
    "```",
    todo.notes || "(empty)",
    "```",
    "",
    "---",
    "Filed by `/todo triage` (@getpipher/armory-todo). This is a sealed record, not open work — the issue is intentionally closed.",
  ].filter((l) => l !== "").join("\n");
}

/** File one closed todo as a CLOSED issue. Idempotent by title search; every
 *  failure mode degrades to a `skipped-*` filing — never throws, never blocks
 *  the local archive (D4). */
export async function fileClosedTodo(gh: GhRunner, todo: Todo, decision: TriageDecision): Promise<LedgerFiling> {
  try {
    const existing = await findLedgerIssue(gh, todo.id);
    if (existing) return { id: todo.id, status: "skipped-existing", url: existing };

    const repoErr = await ensureLedgerRepo(gh);
    if (repoErr) return { id: todo.id, status: "skipped-gh-error", error: repoErr };

    const title = `[archive] ${todo.id} ${todo.title}`.slice(0, 220);
    // D4 verdict labels: triage closes are cancellations (reversible via restore).
    const labels = ["todo-archive", projectLabel(todo.project), `verdict/${decision.verdict === "close" ? "cancel" : "close"}`];
    // NOTE: the create-issues REST endpoint has no `state` field — it silently
    // ignores one (proven in smoke). Create, then PATCH closed.
    const create = await gh([
      "api", `repos/${ledgerRepo()}/issues`,
      "-f", `title=${title}`,
      "-f", `body=${ledgerBody(todo, decision)}`,
      ...labels.flatMap((l) => ["-f", `labels[]=${l}`]),
    ]);
    if (create.code !== 0) {
      return { id: todo.id, status: "skipped-gh-error", error: (create.stderr || "gh api failed").trim().slice(0, 200) };
    }
    let url = "";
    let number = 0;
    try {
      const parsed = JSON.parse(create.stdout) as { html_url?: string; number?: number };
      url = parsed.html_url ?? "";
      number = parsed.number ?? 0;
    } catch { /* url/number best-effort */ }
    if (number > 0) {
      // Records, not work: close immediately. A failed close still files the
      // record (url below) but flags it — the issue would need a manual close.
      const close = await gh(["api", "-X", "PATCH", `repos/${ledgerRepo()}/issues/${number}`, "-f", "state=closed"]);
      if (close.code !== 0) {
        return { id: todo.id, status: "filed", url: url || undefined, error: `filed but CLOSE FAILED (needs manual close): ${(close.stderr || "patch failed").trim().slice(0, 150)}` };
      }
    }
    return { id: todo.id, status: "filed", url: url || undefined };
  } catch (e) {
    return { id: todo.id, status: "skipped-gh-error", error: (e as Error).message.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Rendering (shared by the tool action + the slash mirror)

export function renderProposalTable(gather: GatherResult): string {
  const rows = gather.candidates.map((c) => {
    const proj = c.todo.project || "(none)";
    const safe = c.mechanicalSafe ? " yes" : "";
    return `| ${c.todo.id} | ${c.todo.title} | ${proj} | ${c.categories.join("+")} | ${c.ageDays}d |${safe} |`;
  });
  return [
    `| id | title | project | categories | age | safe(--yes) |`,
    `|---|---|---|---|---|---|`,
    ...rows,
  ].join("\n");
}

export function renderReport(report: TriageReport, before?: GatherResult["before"]): string {
  const lines: string[] = ["## Triage — executed"];
  if (before) lines.push(`before: ${before.active} active / ${before.parked} parked / ${before.archive} archive`);
  if (report.closed.length) {
    lines.push(`closed (${report.closed.length}):`);
    for (const c of report.closed) {
      const filing = report.filings.find((f) => f.id === c.id);
      const ledger = filing?.status === "filed" ? ` · ledger: ${filing.url}`
        : filing?.status === "skipped-existing" ? " · ledger: already filed"
        : filing?.status === "skipped-gh-error" ? ` · ledger: SKIPPED (${filing.error})`
        : filing?.status === "skipped-duplicate-id" ? " · ledger: skipped (duplicate)"
        : " · ledger: not filed";
      lines.push(`  [${c.id}] ${c.title}${c.project ? ` (${c.project})` : ""}${ledger}`);
    }
  } else {
    lines.push("closed: (none)");
  }
  if (report.parked.length) {
    lines.push(`parked (${report.parked.length}): ${report.parked.map((p) => `[${p.id}] ${p.title}`).join(", ")}`);
  }
  if (report.kept.length) {
    lines.push(`kept (${report.kept.length}): ${report.kept.map((k) => `[${k.id}] ${k.title}`).join(", ")}`);
  }
  if (report.rejected.length) {
    lines.push(`rejected (${report.rejected.length}):`);
    for (const r of report.rejected) lines.push(`  [${r.id}] ${r.error}`);
  }
  if (report.closed.length) lines.push(`prune sweep: ${report.pruned} moved to archive (reversible via todo restore <id>)`);
  lines.push(`after: ${report.after.active} active / ${report.after.parked} parked / ${report.after.archive} archive`);
  return lines.join("\n");
}
