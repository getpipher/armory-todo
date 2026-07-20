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