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
}

export interface TodoConfig {
  version: 1;
  prune: PruneConfig;
  health: HealthConfig;
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
    return {
      version: 1,
      prune: { ...DEFAULT_CONFIG.prune, ...parsed.prune },
      health: { ...DEFAULT_CONFIG.health, ...parsed.health },
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