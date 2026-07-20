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