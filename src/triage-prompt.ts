// The /todo triage validation rubric — a VERSIONED PROMPT CONSTANT.
//
// PRD ("The pipeline", stage 2): the agent prompt for the VALIDATE stage ships
// IN the package, not improvised per session — so the rubric evolves
// deliberately (bump TRIAGE_PROMPT_VERSION + tests when changing it) and every
// triage run, in any session, judges against the same contract.
//
// The rubric is derived from PRD §D3 (which itself was distilled from the
// 2026-08-30 manual triage). Evidence must be CHECKED (read-only git/gh/npm
// probes), never guessed. D2 is restated here because it is load-bearing:
// nothing mutates before the batch approval; the caller (extension) enforces
// it mechanically — the prompt is the judgment-side half of the same gate.

import type { Candidate } from "./triage.ts";

export const TRIAGE_PROMPT_VERSION = "triage-rubric/v1";

export const TRIAGE_RUBRIC = `## Triage rubric (${TRIAGE_PROMPT_VERSION})

You are validating TODO-triage candidates. For EACH candidate, judge it against
this rubric and produce one decision. Work top to bottom; do not skip rows.

### Verdicts

| Signal (checked, not guessed) | Verdict |
|---|---|
| source is an agent/fleet run, title is a subagent prompt, and the project work is verifiably merged/released | close (reason: debris) |
| near-identical title/body to another LIVE todo in the same project | close (reason: duplicate) — name the surviving id |
| done-able in <5 minutes, or explicitly deadline-bound | keep — surface it to the owner in your summary |
| real work, low priority, no date | park |
| stale >=30d and you could NOT verify anything | close (reason: stale-unverified) — this stays a proposal for the human |
| fresh, in_progress, or produced by a configured auto-reap source | (never a candidate — the engine already excluded these) |

### Evidence rules (D3 — checked, not guessed)

- Use READ-ONLY probes only: \`git -C <repo> log --oneline -10\`,
  \`gh run list -R <org>/<repo> --limit 3\`, \`npm view <pkg> version\`,
  \`gh pr list -R <org>/<repo> --state merged --search <title>\`.
- NEVER run mutating commands during validation (no push, no gh issue create,
  no npm publish). Filing happens later, mechanically, by the tool.
- One line of evidence per decision. If you found nothing, say what you
  checked: "git log + npm view @x/y — no trace of the described work".
- Confidence: high = direct proof (merged PR / published version); medium =
  strong indirect (branch gone, issue closed by commit); low = judgment call.

### Safety contract (D2 — load-bearing)

- You NEVER mutate anything. Your output is proposals only.
- The tool executes strictly what the user approves in the batch confirm.
- A todo you cannot verify is a PROPOSAL, never an auto-close. Zero
  false-closes is the success metric: a closed item that had to be restored
  is a rubric bug.

### Output contract

Return one decision object per candidate, in order:

{ "id": "<td-...>", "verdict": "close" | "park" | "keep",
  "reason": "debris" | "duplicate" | "stale-unverified" | "verified-shipped",  // close only
  "evidence": "<one checked line>",
  "confidence": "high" | "medium" | "low",
  "survivorId": "<td-...>" }   // duplicate only

Then present the full proposal table (id / title / project / verdict /
evidence / confidence) to the user and wait for ONE batch approval. On
approval, submit all decisions in a single
todo(action:"triage", approve:[...]) call.`;

/** Compose the full agent prompt: rubric + the concrete candidate rows. */
export function buildTriagePrompt(candidates: Candidate[], scope?: string): string {
  const rows = candidates.map((c) => {
    const cats = c.categories.join("+");
    return `- [${c.todo.id}] (${c.todo.project || "no project"}, age ${c.ageDays}d, ${cats}${c.mechanicalSafe ? ", mechanical-safe" : ""}) ${c.todo.title}`;
  });
  return [
    TRIAGE_RUBRIC,
    "",
    `## Candidates (${candidates.length}${scope ? `, scope: ${scope}` : ""})`,
    rows.join("\n"),
  ].join("\n");
}
