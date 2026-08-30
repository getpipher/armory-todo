// /todo triage engine tests — HERMETIC.
//
// Every test runs against a temp store fixture (TODO_DIR env) — NEVER the live
// ~/.pi/agent/todo store. Ledger filing uses an injected fake gh runner — no
// network, no real repo. These two rules are the whole point of this suite.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync } from "node:fs";
import {
  addTodo,
  loadStore,
  saveStore,
  getTodo,
} from "../src/todo-store.ts";
import { loadArchive } from "../src/archive.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { loadRegistry, saveRegistry, setProjectMaxOpen } from "../src/registry.ts";
import {
  gatherCandidates,
  executeTriage,
  executeSafeClass,
  isPromptShapedTitle,
  isMechanicalSafe,
  fileClosedTodo,
  ensureLedgerRepo,
  TRIAGE_LEDGER_REPO_DEFAULT,
  renderProposalTable,
  renderReport,
  type TriageDecision,
  type GhRunner,
  type LedgerFiling,
} from "../src/triage.ts";
import { buildTriagePrompt, TRIAGE_PROMPT_VERSION, TRIAGE_RUBRIC } from "../src/triage-prompt.ts";
import type { Todo } from "../src/todo-store.ts";

const TMP = `${import.meta.dirname}/tmp-triage`;
const DAY = 86_400_000;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.TODO_DIR = TMP;
  delete process.env.TODO_LEDGER_REPO;
});
afterEach(() => {
  delete process.env.TODO_DIR;
  delete process.env.TODO_LEDGER_REPO;
  rmSync(TMP, { recursive: true, force: true });
});

/** Create an open todo and backdate it to simulate staleness. */
function staleTodo(opts: {
  title?: string;
  project?: string;
  source?: string;
  tags?: string[];
  ageDays?: number;
  status?: "open" | "in_progress" | "parked";
}): string {
  const t = addTodo({
    title: opts.title ?? "real backlog item",
    project: opts.project,
    source: opts.source,
    tags: opts.tags,
  });
  const ageDays = opts.ageDays ?? 0;
  if (ageDays > 0 || opts.status) {
    const ts = new Date(Date.now() - ageDays * DAY).toISOString();
    const s = loadStore();
    const row = s.todos.find((x) => x.id === t.id)!;
    row.updatedAt = ts;
    row.createdAt = ts;
    if (opts.status) row.status = opts.status;
    saveStore(s);
  }
  return t.id;
}

/** Stateful fake gh: tracks filed issues (title -> {url, state}), records every
 *  call, and can fail specific subcommands — enough to prove idempotency + the
 *  never-blocking contract without any network. Mirrors the REAL call shapes:
 *  issue list (full list, client-side match), repo view/create, api create,
 *  api PATCH close. */
function fakeGh(opts: {
  issues?: Map<string, { url: string; state: "open" | "closed" }>;
  calls?: string[][];
  fail?: (args: string[]) => boolean;        // return true to force non-zero exit
} = {}): GhRunner {
  const issues = opts.issues ?? new Map<string, { url: string; state: "open" | "closed" }>();
  const calls = opts.calls ?? [];
  let n = 0;
  return async (args) => {
    calls.push(args);
    if (opts.fail?.(args)) return { code: 1, stdout: "", stderr: "gh: simulated failure" };
    if (args[0] === "issue" && args[1] === "list") {
      const all = [...issues.entries()].filter(([title]) => title !== "__repo__")
        .map(([title, v]) => ({ title, url: v.url, state: v.state }));
      return { code: 0, stdout: JSON.stringify(all), stderr: "" };
    }
    if (args[0] === "repo" && args[1] === "view") {
      return issues.has("__repo__") ? { code: 0, stdout: "{}", stderr: "" } : { code: 1, stdout: "", stderr: "not found" };
    }
    if (args[0] === "repo" && args[1] === "create") {
      issues.set("__repo__", { url: "https://github.com/getpipher/todo-ledger", state: "open" });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
      const n = Number(args[3].split("/").pop());
      const hit = [...issues.entries()].find(([, v]) => v.url.endsWith(`/issues/${n}`));
      if (hit) hit[1].state = "closed";
      return { code: 0, stdout: "{}", stderr: "" };
    }
    if (args[0] === "api" && args[1]?.startsWith("repos/")) {
      const title = (args.find((a) => a.startsWith("title=")) ?? "").slice(6);
      const url = `https://github.com/getpipher/todo-ledger/issues/${++n}`;
      issues.set(title, { url, state: "open" }); // created OPEN — closed by the PATCH
      return { code: 0, stdout: JSON.stringify({ number: n, html_url: url }), stderr: "" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  };
}

// ---------------------------------------------------------------------------
// gather

describe("gatherCandidates", () => {
  it("collects a stale open todo (stale-30d + orphan-14d) and does not mutate anything", () => {
    const id = staleTodo({ ageDays: 35, project: "core" });
    const storeBefore = JSON.stringify(loadStore());
    const g = gatherCandidates();
    assert.equal(g.candidates.length, 1);
    assert.equal(g.candidates[0].todo.id, id);
    assert.ok(g.candidates[0].categories.includes("stale-30d"));
    assert.ok(g.candidates[0].categories.includes("orphan-14d"));
    assert.equal(g.candidates[0].mechanicalSafe, false);
    assert.equal(JSON.stringify(loadStore()), storeBefore, "gather must be a pure read");
  });

  it("excludes fresh open, stale in_progress, and stale parked todos (D3: untouched)", () => {
    staleTodo({ ageDays: 0 });
    staleTodo({ ageDays: 90, status: "in_progress" });
    staleTodo({ ageDays: 90, status: "parked" });
    const g = gatherCandidates();
    assert.deepEqual(g.candidates.map((c) => c.todo.id), []);
  });

  it("marks fleet-run prompt debris mechanical-safe (agent-source category)", () => {
    const id = staleTodo({
      title: "You are implementing Task 9: E2E legs, scripts, README, full graduation gate",
      project: "fleet",
      ageDays: 20,
    });
    const g = gatherCandidates();
    assert.equal(g.candidates.length, 1);
    assert.equal(g.candidates[0].todo.id, id);
    assert.ok(g.candidates[0].categories.includes("agent-source"));
    assert.equal(g.candidates[0].mechanicalSafe, true);
  });

  it("refuses mechanical-safe without BOTH prompt-shaped title and agent context", () => {
    // prompt-shaped title but a human project/source — not safe
    staleTodo({ title: "You are given two candidate renders for the same brief", project: "core", ageDays: 20 });
    // agent context (project fleet) but a human title — not safe
    staleTodo({ title: "spec the gateway retry policy", project: "fleet", ageDays: 20 });
    const g = gatherCandidates();
    assert.equal(g.candidates.length, 2);
    for (const c of g.candidates) assert.equal(c.mechanicalSafe, false);
  });

  it("never treats a reap-policy source as a triage candidate (reap.ts owns those)", () => {
    staleTodo({ source: "armory-fleet", title: "You are COMPLETING Task 3: MCP client wrapper", ageDays: 90 });
    const g = gatherCandidates();
    assert.equal(g.candidates.length, 0);
  });

  it("flags members of an over-cap project (over-cap-project category)", () => {
    const a = staleTodo({ project: "nuntius", ageDays: 1 });
    const b = staleTodo({ project: "nuntius", ageDays: 1 });
    const reg = loadRegistry();
    setProjectMaxOpen(reg, "nuntius", 1);
    saveRegistry(reg);
    const g = gatherCandidates();
    assert.deepEqual(g.candidates.map((c) => c.todo.id).sort(), [a, b].sort());
    for (const c of g.candidates) {
      assert.ok(c.categories.includes("over-cap-project"));
      assert.equal(c.mechanicalSafe, false);
    }
    assert.deepEqual(g.overCapProjects, [{ name: "nuntius", open: 2, maxOpen: 1 }]);
  });

  it("respects the scope filter", () => {
    staleTodo({ ageDays: 35, project: "core" });
    const kept = staleTodo({ ageDays: 35, project: "nuntius" });
    const g = gatherCandidates("nuntius");
    assert.equal(g.candidates.length, 1);
    assert.equal(g.candidates[0].todo.id, kept);
    assert.equal(g.scope, "nuntius");
  });

  it("reports before counts from the live + archive stores", () => {
    staleTodo({ ageDays: 1 });
    staleTodo({ ageDays: 1, status: "parked" });
    const g = gatherCandidates();
    assert.deepEqual(g.before, { active: 1, parked: 1, archive: 0 });
    assert.equal(g.staleDays, 30);
    assert.equal(g.orphanDays, 14);
  });

  it("uses config thresholds (not hardcoded 30/14)", () => {
    const cfg = loadConfig();
    cfg.health.activeStaleDays = 7;
    cfg.reap.orphanFlagAfterDays = 3;
    saveConfig(cfg);
    const id = staleTodo({ ageDays: 9 });
    const g = gatherCandidates();
    assert.ok(g.candidates.some((c) => c.todo.id === id));
    assert.equal(g.staleDays, 7);
    assert.equal(g.orphanDays, 3);
  });
});

// ---------------------------------------------------------------------------
// prompt-shaped / safe-class heuristics

describe("triage heuristics", () => {
  it("recognizes fleet prompt titles, rejects human titles", () => {
    assert.equal(isPromptShapedTitle("You are COMPLETING Task 9: E2E legs"), true);
    assert.equal(isPromptShapedTitle("you are given two candidate renders"), true);
    assert.equal(isPromptShapedTitle("[general-purpose] You are implementing Task 7"), true);
    assert.equal(isPromptShapedTitle("spec the gateway retry policy"), false);
    assert.equal(isPromptShapedTitle("Nuntius dry-run follow-ups"), false);
  });

  it("mechanical-safe requires open status too", () => {
    const t = { status: "in_progress", source: "", project: "fleet", tags: [], title: "You are Task 3" } as Todo;
    assert.equal(isMechanicalSafe(t, new Set()), false);
  });
});

// ---------------------------------------------------------------------------
// execute — the D2 approval gate

describe("executeTriage", () => {
  it("executes close/park/keep exactly as approved and sweeps closed items to the archive", async () => {
    const closeMe = staleTodo({ ageDays: 35, project: "fleet" });
    const parkMe = staleTodo({ ageDays: 35, project: "core" });
    const keepMe = staleTodo({ ageDays: 35, project: "core" });
    const decisions: TriageDecision[] = [
      { id: closeMe, verdict: "close", reason: "debris", evidence: "merged + released", confidence: "high" },
      { id: parkMe, verdict: "park", confidence: "high" },
      { id: keepMe, verdict: "keep" },
    ];
    const report = await executeTriage(decisions, { skipFiling: true });

    assert.deepEqual(report.closed.map((c) => c.id), [closeMe]);
    assert.deepEqual(report.parked.map((p) => p.id), [parkMe]);
    assert.deepEqual(report.kept.map((k) => k.id), [keepMe]);
    assert.equal(getTodo(parkMe).status, "parked");
    assert.equal(getTodo(keepMe).status, "open");
    assert.throws(() => getTodo(closeMe), /no todo with id/); // left the live store...
    assert.equal(loadArchive().todos.find((t) => t.id === closeMe)?.status, "cancelled"); // ...into the archive
    assert.equal(report.pruned, 1);
    assert.deepEqual(report.after, { active: 1, parked: 1, archive: 1 });
    assert.equal(report.filings.length, 0, "skipFiling must suppress gh entirely");
  });

  it("D2 gate: a malformed decision is rejected and mutates nothing", async () => {
    const id = staleTodo({ ageDays: 35 });
    for (const bad of [
      { id, verdict: "close" } as TriageDecision,                        // close without reason
      { id, verdict: "close", reason: "duplicate" } as TriageDecision,   // duplicate without survivorId
      { id, verdict: "close", reason: "verified-shipped" } as TriageDecision, // no evidence
      { id, verdict: "nuke" } as unknown as TriageDecision,              // invalid verdict
    ]) {
      const report = await executeTriage([bad], { skipFiling: true });
      assert.equal(report.rejected.length, 1, `expected rejection for ${JSON.stringify(bad)}`);
      assert.equal(getTodo(id).status, "open", "rejected decisions must never mutate");
    }
  });

  it("rejects unknown ids and non-open todos without aborting the rest of the batch", async () => {
    const good = staleTodo({ ageDays: 35 });
    const parkedId = staleTodo({ ageDays: 35, status: "parked" });
    const report = await executeTriage([
      { id: "td-does-not-exist", verdict: "close", reason: "debris" },
      { id: parkedId, verdict: "close", reason: "debris" },
      { id: good, verdict: "park" },
    ], { skipFiling: true });

    assert.equal(report.parked.length, 1);
    assert.equal(report.parked[0].id, good);
    assert.equal(report.rejected.length, 2);
    assert.ok(report.rejected.some((r) => r.id === "td-does-not-exist" && /no todo with id/.test(r.error)));
    assert.ok(report.rejected.some((r) => r.id === parkedId && /not open/.test(r.error)));
    assert.equal(getTodo(parkedId).status, "parked", "non-open todo untouched");
  });

  it("reports before/after and accepted duplicate closes carry the survivor", async () => {
    const dup = staleTodo({ ageDays: 35, title: "spec the retry policy", project: "nuntius" });
    const survivor = staleTodo({ ageDays: 2, title: "spec the retry policy v2", project: "nuntius" });
    const report = await executeTriage([
      { id: dup, verdict: "close", reason: "duplicate", survivorId: survivor, evidence: "same task, survivor is newer", confidence: "medium" },
    ], { skipFiling: true });
    assert.equal(report.closed.length, 1);
    assert.equal(loadArchive().todos.find((t) => t.id === dup)?.status, "cancelled");
    assert.equal(getTodo(survivor).status, "open");
  });
});

// ---------------------------------------------------------------------------
// executeSafeClass — the --yes path (D2: safe class only)

describe("executeSafeClass", () => {
  it("closes ONLY mechanical-safe debris; everything else stays a live proposal", async () => {
    const debris = staleTodo({ title: "You are implementing Task 7: README + client helper", project: "fleet", ageDays: 20 });
    const human = staleTodo({ title: "core Dependabot sweep (11 vulns)", project: "core", ageDays: 90 });
    const { report, remaining } = await executeSafeClass(undefined, { skipFiling: true });

    assert.equal(report!.closed.length, 1);
    assert.equal(report!.closed[0].id, debris);
    assert.equal(report!.closed[0].project, "fleet");
    assert.equal(remaining, 1);
    assert.equal(getTodo(human).status, "open", "unverified items are NEVER auto-closed");
    assert.equal(loadArchive().todos.find((t) => t.id === debris)?.status, "cancelled");
  });

  it("returns null report when the store has no safe-class debris", async () => {
    staleTodo({ ageDays: 90, project: "core" });
    const { report, remaining } = await executeSafeClass(undefined, { skipFiling: true });
    assert.equal(report, null);
    assert.equal(remaining, 1);
  });
});

// ---------------------------------------------------------------------------
// ledger filing (D4: private, idempotent, created CLOSED, never blocking)

describe("ledger filing", () => {
  function snapshotOf(id: string): Todo {
    return loadStore().todos.find((t) => t.id === id)!;
  }

  it("files a closed todo as a CLOSED issue with D4 labels and the full note", async () => {
    const id = staleTodo({ ageDays: 35, project: "Nuntius", title: "spec the retry policy" });
    const s = loadStore();
    s.todos.find((t) => t.id === id)!.notes = "the retry notes body";
    saveStore(s);
    const calls: string[][] = [];
    const gh = fakeGh({ calls });
    const filing = await fileClosedTodo(gh, snapshotOf(id), {
      id, verdict: "close", reason: "stale-unverified", evidence: "no trace in git log", confidence: "low",
    });

    assert.equal(filing.status, "filed");
    assert.match(filing.url!, /\/issues\/1$/);
    const create = calls.find((a) => a[0] === "api")!;
    assert.ok(create.some((a) => a === "labels[]=todo-archive"));
    assert.ok(create.some((a) => a === "labels[]=project/nuntius"), "project label is normalized");
    assert.ok(create.some((a) => a === "labels[]=verdict/cancel"));
    assert.ok(!create.some((a) => a.startsWith("state=")), "create-issues API has no state field (silently ignored — proven in smoke)");
    const closeCall = calls.find((a) => a[0] === "api" && a[1] === "-X" && a[2] === "PATCH");
    assert.ok(closeCall, "a second PATCH call closes the issue");
    assert.ok(closeCall!.some((a) => a === "state=closed"));
    const body = create.find((a) => a.startsWith("body="))!.slice(5);
    assert.ok(body.includes(id), "body embeds the td- id");
    assert.ok(body.includes("the retry notes body"), "body embeds the full original note");
    assert.ok(body.includes("stale-unverified"));
    assert.ok(create.find((a) => a.startsWith("title="))!.includes(id));
  });

  it("is idempotent: a second filing of the same id skips via the client-side list match", async () => {
    const id = staleTodo({ ageDays: 35, project: "core" });
    const issues = new Map<string, { url: string; state: "open" | "closed" }>();
    const gh = fakeGh({ issues });
    const decision: TriageDecision = { id, verdict: "close", reason: "debris", evidence: "e", confidence: "high" };

    const first = await fileClosedTodo(gh, snapshotOf(id), decision);
    assert.equal(first.status, "filed");
    const second = await fileClosedTodo(gh, snapshotOf(id), decision);
    assert.equal(second.status, "skipped-existing");
    assert.equal(second.url, first.url, "skip reports the existing issue");
    assert.equal([...issues.values()].filter((v) => v.url !== "https://github.com/getpipher/todo-ledger").length, 1, "exactly one issue exists");
  });

  it("never blocks on gh failure: the todo still archives locally, failure is reported", async () => {
    const id = staleTodo({ ageDays: 35, project: "core" });
    const gh = fakeGh({ fail: () => true });
    const filing = await fileClosedTodo(gh, snapshotOf(id), { id, verdict: "close", reason: "debris" });
    assert.equal(filing.status, "skipped-gh-error");
    assert.ok(filing.error);

    // And at engine level: gh fully down must not stop the batch.
    const report = await executeTriage([{ id, verdict: "close", reason: "debris", evidence: "e" }], { gh });
    assert.equal(report.closed.length, 1);
    assert.equal(loadArchive().todos.find((t) => t.id === id)?.status, "cancelled");
    assert.equal(report.filings[0].status, "skipped-gh-error");
    assert.match(renderReport(report), /ledger: SKIPPED/);
  });

  it("ensureLedgerRepo creates the private repo only when the view probe fails", async () => {
    const calls: string[][] = [];
    const missing = fakeGh({ calls });
    assert.equal(await ensureLedgerRepo(missing), null);
    assert.ok(calls.some((a) => a[1] === "create"), "missing repo -> created");
    const calls2: string[][] = [];
    const presentSpy = fakeGh({ calls: calls2, issues: new Map([["__repo__", { url: "u", state: "open" }]]) });
    assert.equal(await ensureLedgerRepo(presentSpy), null);
    assert.ok(!calls2.some((a) => a[1] === "create"), "existing repo -> no create call");
    const broken = fakeGh({ fail: () => true });
    assert.ok(await ensureLedgerRepo(broken), "unusable gh -> error string (caller skips)");
  });

  it("respects the TODO_LEDGER_REPO env override for scratch runs", async () => {
    process.env.TODO_LEDGER_REPO = "scratch/ledger-test";
    const calls: string[][] = [];
    const gh = fakeGh({ calls });
    const id = staleTodo({ ageDays: 35 });
    await fileClosedTodo(gh, snapshotOf(id), { id, verdict: "close", reason: "debris" });
    const listCall = calls.find((a) => a[0] === "issue")!;
    assert.ok(listCall.includes("scratch/ledger-test"));
  });
});

// ---------------------------------------------------------------------------
// proposal table / report rendering + rubric prompt

describe("triage rendering + prompt", () => {
  it("renders a proposal table with the mechanical-safe marker", () => {
    const debris = staleTodo({ title: "You are Task 3: wrapper", project: "fleet", ageDays: 20 });
    const human = staleTodo({ title: "old backlog", project: "core", ageDays: 90 });
    const g = gatherCandidates();
    const table = renderProposalTable(g);
    assert.match(table, /\| id \| title \| project \| categories \| age \| safe\(--yes\) \|/);
    assert.ok(table.includes(debris));
    assert.ok(table.includes(human));
    assert.match(table, / yes \|/);
  });

  it("renders a report with before/after, filings, and rejections", async () => {
    const id = staleTodo({ ageDays: 35 });
    const report = await executeTriage([{ id, verdict: "close", reason: "debris", evidence: "e" }], { skipFiling: true });
    const text = renderReport(report, { active: 1, parked: 0, archive: 0 });
    assert.match(text, /before: 1 active/);
    assert.match(text, /closed \(1\)/);
    assert.match(text, /prune sweep: 1 moved/);
    assert.match(text, /after: 0 active/);
  });

  it("ships the versioned rubric with the D3 rows and the D2 safety contract", () => {
    assert.equal(TRIAGE_PROMPT_VERSION, "triage-rubric/v1");
    assert.match(TRIAGE_RUBRIC, /reason: debris\)/);
    assert.match(TRIAGE_RUBRIC, /duplicate/);
    assert.match(TRIAGE_RUBRIC, /park/);
    assert.match(TRIAGE_RUBRIC, /stale-unverified/);
    assert.match(TRIAGE_RUBRIC, /never mutate anything|NEVER mutate/i);
    assert.match(TRIAGE_RUBRIC, /READ-ONLY probes/);
    const id = staleTodo({ ageDays: 35 });
    const prompt = buildTriagePrompt(gatherCandidates().candidates);
    assert.match(prompt, /triage-rubric\/v1/);
    assert.ok(prompt.includes(id));
    assert.match(prompt, /Candidates \(1/);
  });

  it("exposes the pinned ledger repo by default", () => {
    assert.equal(process.env.TODO_LEDGER_REPO, undefined);
    assert.equal(TRIAGE_LEDGER_REPO_DEFAULT, "getpipher/todo-ledger");
  });
});
