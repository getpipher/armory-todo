// Write-audit + backup for armory-todo (v0.5.1 hardening, post v0.2.0 data-loss
// incident). Every saveStore / saveArchive now:
//   1. backs up the current file to <path>.bak (rolling previous version — the
//      immediate recovery target);
//   2. if the save would DROP the todo count (after < before), also snapshots
//      the pre-write file to <path>.bak-drop-<ts> (timestamped, never
//      overwritten — the preserved pre-wipe state, the trap);
//   3. appends one compact line to <TODO_DIR>/todo-audit.log (counts only, no
//      todo content — privacy-safe) flagging drops with ⚠ DROP.
//
// This means the v0.2.0-style "migration wiped the store" incident is now
// recoverable: the .bak-drop-<ts> holds the pre-wipe state, and the audit log
// names the moment + the count delta.
//
// Pure fs helpers (no pi imports) so they're unit-testable in isolation.

import { chmodSync, copyFileSync, existsSync, mkdirSync, appendFileSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getTodoDir } from "./paths.ts";

/** Copy the current file to <path>.bak (rolling previous version). No-op if the
 *  file doesn't exist yet (first-ever save). Returns true if a backup was made. */
export function backupFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    copyFileSync(path, `${path}.bak`);
    return true;
  } catch {
    // best-effort; a failed backup must not block the write
    return false;
  }
}

/** If a count drop is detected (after < before), snapshot the pre-write file to
 *  <path>.bak-drop-<ts> (preserved — never overwritten by the rolling .bak).
 *  Returns the snapshot path, or null if no snapshot was taken. */
export function snapshotOnDrop(path: string, before: number, after: number): string | null {
  if (before <= after) return null;            // no drop (growth or steady)
  if (!existsSync(path)) return null;          // nothing to snapshot
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const snap = `${path}.bak-drop-${ts}`;
  try {
    copyFileSync(path, snap);
    return snap;
  } catch {
    return null;
  }
}

/** Append one compact audit line. Counts only (no todo content). Flags drops.
 *  `box` is "todo" or "archive" (which file was saved). */
export function appendAudit(box: "todo" | "archive", before: number, after: number, dropSnap: string | null): void {
  try {
    const dir = getTodoDir();
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "todo-audit.log");
    const ts = new Date().toISOString();
    const delta = after - before;
    const flag = after < before ? " [⚠ DROP]" : "";
    const snap = dropSnap ? ` snap=${dropSnap.split("/").pop()}` : "";
    appendFileSync(logPath, `${ts} save ${box}.json ${before}→${after} ${delta >= 0 ? "+" : ""}${delta}${flag}${snap}\n`, { encoding: "utf8" });
    try { chmodSync(logPath, 0o600); } catch { /* fs may ignore mode */ }
  } catch {
    // best-effort; audit must not block the write
  }
}

/** Count todos in an existing store file (for the before-count). Returns 0 if the
 *  file is missing/unreadable/not a valid store. */
export function countTodosInFile(path: string): number {
  try {
    if (!existsSync(path)) return 0;
    const raw = statSync(path).size === 0 ? null : readJson(path);
    if (!raw || !Array.isArray(raw.todos)) return 0;
    return raw.todos.length;
  } catch {
    return 0;
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}