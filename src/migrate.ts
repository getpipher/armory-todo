// One-time v1 → v2 migration: move the legacy single-file store
// (~/.pi/agent/todo.json) into the v2 folder layout (~/.pi/agent/todo/todo.json).
//
// Pure + testable: takes explicit paths rather than reading env, so tests can
// point at temp dirs without touching the real home directory.
//
// Idempotent: if the target todo.json already exists, do nothing (the user
// already migrated, or started fresh on v2).

import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// v2 → v3 schema migration helpers. splitTextFallback is used by loadStore's
// inline derivation (Task 1) and by migrateV2ToV3 (Task 2, with the curated
// map). TITLE_MAX here must match the constant in todo-store.ts.
const TITLE_MAX = 120;

/** Truncate at the last word boundary ≤ TITLE_MAX (hard cut if none). No "…"
 *  suffix — the cap is a hard rule, not a display truncation. */
function truncateWordBoundary(s: string): string {
  if (s.length <= TITLE_MAX) return s;
  const slice = s.slice(0, TITLE_MAX);
  const sp = slice.lastIndexOf(" ");
  return sp > 0 ? slice.slice(0, sp) : slice;
}

/** Derive { title, notes } from a v2 `text` string (the fallback for any v2
 *  todo not in the curated map). Deterministic + idempotent. */
export function splitTextFallback(text: string): { title: string; notes: string } {
  const raw = (text ?? "").trim();
  if (!raw) return { title: "(untitled)", notes: "" };
  const nl = raw.indexOf("\n");
  if (nl < 0) {
    if (raw.length <= TITLE_MAX) return { title: raw, notes: "" };
    return { title: truncateWordBoundary(raw), notes: raw };
  }
  const firstLine = raw.slice(0, nl).trim();
  const rest = raw.slice(nl + 1).trim();
  if (firstLine.length <= TITLE_MAX) return { title: firstLine, notes: rest };
  return { title: truncateWordBoundary(firstLine), notes: `${firstLine}\n${rest}` };
}

export interface MigrateInput {
  /** The v2 folder (e.g. ~/.pi/agent/todo/). */
  todoDir: string;
  /** The pre-v2 single file (e.g. ~/.pi/agent/todo.json). */
  legacyPath: string;
}

/**
 * If `<todoDir>/todo.json` does not exist but `legacyPath` does, create the
 * folder and move the legacy file in. Atomic-ish: the legacy file is copied
 * first (as a .bak), then moved, so a mid-move failure leaves the legacy file
 * intact. Safe to call on every load.
 */
export function migrateIfNeeded(input: MigrateInput): void {
  const target = join(input.todoDir, "todo.json");
  if (existsSync(target)) return; // already v2
  if (!existsSync(input.legacyPath)) return; // nothing to migrate

  mkdirSync(input.todoDir, { recursive: true });
  // Copy-then-rename so the legacy file survives a crash between copy + rename.
  const backup = `${input.legacyPath}.migrate-bak-${Date.now()}`;
  copyFileSync(input.legacyPath, backup);
  try {
    renameSync(input.legacyPath, target);
    // success → remove the backup
    try { unlinkSync(backup); } catch { /* best-effort */ }
  } catch {
    // rename failed → restore from backup (legacy file may have been moved
    // on some filesystems; copy it back to be safe)
    try { copyFileSync(backup, input.legacyPath); } catch { /* best-effort */ }
    throw new Error(`migration failed: could not move ${input.legacyPath} → ${target}`);
  }
}
// v2 → v3 schema migration: each todo gains title + notes (curated for the
// 2 ids known at migration time; splitTextFallback for the rest), drops text.
// Pure — does not touch disk. Deterministic + idempotent on v2 input.
// (splitTextFallback + TITLE_MAX are defined above, alongside migrateIfNeeded.)

/** A v2 todo (has `text`, no `title`/`notes`). */
export interface V2Todo {
  id: string;
  text: string;
  project: string;
  tags: string[];
  priority: string;
  status: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

/** v2 store shape (input to migrateV2ToV3). */
export interface V2Store {
  version: 2;
  updatedAt: string;
  todos: V2Todo[];
}

// Hand-curated title + notes for the 2 todos known at v2→v3 migration time
// (the only survivors of the v0.2.0 incident). Any other v2 todo uses
// splitTextFallback. Curated notes are reformatted for clarity, not a
// mechanical split.
const CURATED_V2_TO_V3: Record<string, { title: string; notes: string }> = {
  "td-mrt3zp9fcnug3p": {
    title: "ZeroClaw×Solana bounty — Phase 4-5: demo video (score bottleneck, unstarted)",
    notes: `superteam.fun/earn/listing/zeroclaw · Superteam Brasil · 5,000 USDG pool / 1st=1,800 · winner Aug 21 2026 · TARGET #1.

PHASE 0-2 DONE ✅. PHASE 3 (RESEARCH+SPEC+PLAN + impl alerts+custody+docs) DONE ✅ — slices A-F+H, 45 tests, committed 8fd7483→80614c8, PUSHED, PR #76 retitled "Palinurus — depin-attest + depin-rewards", 17 commits.

claim_tx (G) DEFERRED — Helium hotspots are cNFTs → claim needs distribute_compression_rewards_v0 + DAS get_asset_proof (merkle proof), multi-session; PDAs verified, design in README.

Decision (score-max): ship alerts core complete, pivot to DEMO track.

NEXT (★ Phase 4-5, the score bottleneck — submission REQUIRES a demo video, currently unstarted):
(1) ASYNC: RECTOR's free Relay Community key → real Helium fixtures + live smoke test;
(2) Phase 4: wiring SVG (docs/wiring-diagram.svg, dark-mode, NOT ASCII) + marketing site (palinurus.rectorspace.com, Next.js+Tailwind+shadcn) + demo recording guide;
(3) Phase 5: record demo ≤3min (real ZeroClaw+Telegram, terminal+phone) → ElevenLabs voiceover → ffmpeg → submit on Superteam Earn + engage #solana-bounty Discord.

Test totals: 184 (71 palinurus-core + 68 depin-attest + 45 depin-rewards), all clippy+wasm clean.
HANDOFF: ~/Documents/secret/strategy/zeroclaw-solana/session-handoff-2026-07-21.md
Docs: {RESEARCH-3,SPEC-3,PLAN-3}-depin-rewards.md (SPEC-3 §4 + PLAN-3 G corrected for cNFT)
Cwd: ~/local-dev/RECTOR-LABS/zeroclaw-plugins/plugins/depin-rewards
PR: https://github.com/zeroclaw-labs/zeroclaw-plugins/pull/76`,
  },
  "td-mrt4e1qi9td6jz": {
    title: "armory-todo v0.2.0 — Workstream A shipped (lifecycle boxes + prune + health + TUI)",
    notes: `ALL 3 SPECS DONE ✅. SPEC-1 (store: parked+prune+archive+restore, 12 tasks), SPEC-2 (health+hard-prune, 6 tasks), SPEC-3 (interactive /todo TUI panel, 4 tasks). 147/147 tests across 7 suites. 24 commits on feat/spec-1-lifecycle-boxes, PR #3 retitled to full v0.2.0 scope. Auto-publish CI (release.yml, org NPM_TOKEN).

INCIDENT (SPEC-1 Task 9): migration bug destroyed real 52KB/47-todo store (35 done + ~10 open lost, no backup). FIXED (c034509): migration guarded to only run when TODO_DIR is default. RECOVERED: 2 todos.

Shipped: merge PR #3 → tag v0.2.0 → CI auto-publish → npm:@getpipher/armory-todo@0.2.0.
Out of scope: B (title+notes split), C (preventive caps+project registry).`,
  },
};

/** Transform a v2 store into a v3 store: each todo gains title + notes
 *  (curated for the 2 known ids, splitTextFallback for the rest), drops text.
 *  Pure — does not touch disk. Deterministic + idempotent on v2 input. */
export function migrateV2ToV3(store: V2Store): { version: 3; updatedAt: string; todos: any[] } {
  const todos = store.todos.map((t) => {
    const curated = CURATED_V2_TO_V3[t.id];
    if (curated) {
      const { text: _drop, ...rest } = t;
      return { ...rest, title: curated.title, notes: curated.notes };
    }
    const { title, notes } = splitTextFallback(t.text ?? "");
    const { text: _drop, ...rest } = t;
    return { ...rest, title, notes };
  });
  return { version: 3, updatedAt: store.updatedAt, todos };
}
