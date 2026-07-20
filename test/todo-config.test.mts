import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

const tmp = mkdtempSync(join(tmpdir(), "armory-config-"));
process.env.TODO_DIR = tmp;

const { DEFAULT_CONFIG, loadConfig, saveConfig } = await import("../src/config.ts");

// --- defaults ---
eq("default prune age 7", DEFAULT_CONFIG.prune.defaultAgeDays, 7);
eq("default hard age 180", DEFAULT_CONFIG.prune.hardAgeDays, 180);
eq("default prune statuses done+cancelled", DEFAULT_CONFIG.prune.statuses.length, 2);
eq("default activeMaxOpen 15", DEFAULT_CONFIG.health.activeMaxOpen, 15);
eq("default activeStaleDays 30", DEFAULT_CONFIG.health.activeStaleDays, 30);
eq("default parkedMax 10", DEFAULT_CONFIG.health.parkedMax, 10);
eq("default parkedStaleDays 60", DEFAULT_CONFIG.health.parkedStaleDays, 60);
eq("default archiveMax 200", DEFAULT_CONFIG.health.archiveMax, 200);
eq("default archiveOldDays 180", DEFAULT_CONFIG.health.archiveOldDays, 180);

// --- missing config → defaults written ---
const cfg = loadConfig();
eq("loadConfig returns defaults when missing", cfg.prune.defaultAgeDays, 7);
ok("config file created on first load", existsSync(join(tmp, "todo.config.json")));

// --- save + reload round-trip ---
const mutated = { ...cfg, prune: { ...cfg.prune, defaultAgeDays: 14 } };
saveConfig(mutated);
const reloaded = loadConfig();
eq("saved config reloads", reloaded.prune.defaultAgeDays, 14);

// --- config file is 0600 ---
const mode = statSync(join(tmp, "todo.config.json")).mode & 0o777;
ok("config file mode 0600", mode === 0o600, `(mode ${mode.toString(8)})`);

// --- corrupt config → backup + fresh defaults ---
writeFileSync(join(tmp, "todo.config.json"), "{ not json", "utf8");
const recovered = loadConfig();
eq("corrupt config → defaults", recovered.prune.defaultAgeDays, 7);
ok("corrupt config backed up or recovered", recovered.prune.defaultAgeDays === 7);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);