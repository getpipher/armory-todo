// Prune + health configuration for armory-todo.
//
// Stored at <TODO_DIR>/todo.config.json. Missing or corrupt → defaults are
// rewritten (the bad file is backed up to todo.config.json.bad-<ts>). All
// values are editable (later, via the SPEC-3 /todo Config panel).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getConfigPath } from "./paths.ts";

export interface PruneConfig {
  /** Closed todos older than this (by closedAt) are moved to archive on `prune`. */
  defaultAgeDays: number;
  /** Archive items older than this are flagged for hard-prune suggestion. */
  hardAgeDays: number;
  /** Which terminal statuses get pruned. */
  statuses: ("done" | "cancelled")[];
}

export interface HealthConfig {
  activeMaxOpen: number;
  activeStaleDays: number;
  parkedMax: number;
  parkedStaleDays: number;
  archiveMax: number;
  archiveOldDays: number;
  perProjectDefaultMax: number;  // v0.4.0: per-project PROJECT_LARGE threshold (advisory)
  maxNotesBytes: number;         // v0.5.0: per-todo notes byte cap (hard-reject at add/update)
}

export interface NotifyConfig {
  /** Show the `armory-todo: N open TODOs` session-start count line.
   *  Safety messages (wipe-recovery alert, auto-prune undo info) still surface
   *  when this is false. Default true. */
  sessionStartCount: boolean;
}

export interface TodoConfig {
  version: 1;
  prune: PruneConfig;
  health: HealthConfig;
  notify: NotifyConfig;
}

export const DEFAULT_CONFIG: TodoConfig = {
  version: 1,
  prune: {
    defaultAgeDays: 7,
    hardAgeDays: 180,
    statuses: ["done", "cancelled"],
  },
  health: {
    activeMaxOpen: 15,
    activeStaleDays: 30,
    parkedMax: 10,
    parkedStaleDays: 60,
    archiveMax: 200,
    archiveOldDays: 180,
    perProjectDefaultMax: 8,
    maxNotesBytes: 8192,
  },
  notify: {
    sessionStartCount: true,
  },
};

/** Deep clone of DEFAULT_CONFIG (so callers can't mutate the constant). */
function freshDefaults(): TodoConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as TodoConfig;
}

export function loadConfig(): TodoConfig {
  const path = getConfigPath();
  if (!existsSync(path)) {
    const cfg = freshDefaults();
    saveConfig(cfg);
    return cfg;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as TodoConfig;
    if (!parsed || typeof parsed !== "object" || !parsed.prune || !parsed.health) {
      throw new Error("invalid config shape");
    }
    // Merge with defaults so new fields get filled in on upgrade.
    const health = { ...DEFAULT_CONFIG.health, ...parsed.health };
    if (health.perProjectDefaultMax === undefined) health.perProjectDefaultMax = DEFAULT_CONFIG.health.perProjectDefaultMax;
    if (health.maxNotesBytes === undefined || typeof health.maxNotesBytes !== "number" || Number.isNaN(health.maxNotesBytes) || health.maxNotesBytes < 0) {
      health.maxNotesBytes = DEFAULT_CONFIG.health.maxNotesBytes;
    }
    const notify = { ...DEFAULT_CONFIG.notify, ...(parsed.notify ?? {}) };
    if (typeof notify.sessionStartCount !== "boolean") notify.sessionStartCount = true;
    return {
      version: 1,
      prune: { ...DEFAULT_CONFIG.prune, ...parsed.prune },
      health,
      notify,
    };
  } catch {
    try {
      renameSync(path, `${path}.bad-${Date.now()}`);
    } catch {
      // best-effort backup
    }
    const cfg = freshDefaults();
    saveConfig(cfg);
    return cfg;
  }
}

/** Atomic, 0600 write. */
export function saveConfig(config: TodoConfig): void {
  const path = getConfigPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // some filesystems ignore mode bits
  }
  renameSync(tmp, path);
}