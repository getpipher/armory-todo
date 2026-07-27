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
eq("default perProjectDefaultMax 8", DEFAULT_CONFIG.health.perProjectDefaultMax, 8);

// --- v0.5.5: notify.sessionStartCount ---
eq("default notify.sessionStartCount true", DEFAULT_CONFIG.notify.sessionStartCount, true);

// --- missing config → defaults written ---
const cfg = loadConfig();
eq("loadConfig returns defaults when missing", cfg.prune.defaultAgeDays, 7);
ok("config file created on first load", existsSync(join(tmp, "todo.config.json")));

// --- save + reload round-trip ---
const mutated = { ...cfg, prune: { ...cfg.prune, defaultAgeDays: 14 } };
saveConfig(mutated);
const reloaded = loadConfig();
eq("saved config reloads", reloaded.prune.defaultAgeDays, 14);

// --- forward-compatible merge: an old config without perProjectDefaultMax gets the default ---
const oldShape: any = { version: 1, prune: { ...cfg.prune }, health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180 } };
saveConfig(oldShape);
const merged = loadConfig();
eq("missing perProjectDefaultMax → default 8", merged.health.perProjectDefaultMax, 8);

// --- config file is 0600 ---
const mode = statSync(join(tmp, "todo.config.json")).mode & 0o777;
ok("config file mode 0600", mode === 0o600, `(mode ${mode.toString(8)})`);

// --- corrupt config → backup + fresh defaults ---
writeFileSync(join(tmp, "todo.config.json"), "{ not json", "utf8");
const recovered = loadConfig();
eq("corrupt config → defaults", recovered.prune.defaultAgeDays, 7);
ok("corrupt config backed up or recovered", recovered.prune.defaultAgeDays === 7);

// --- v0.5.0: maxNotesBytes ---
eq("default maxNotesBytes 8192", DEFAULT_CONFIG.health.maxNotesBytes, 8192);
eq("loadConfig maxNotesBytes default", loadConfig().health.maxNotesBytes, 8192);

// forward-merge: an old config (no maxNotesBytes) gets the default
writeFileSync(join(tmp, "todo.config.json"), JSON.stringify({
  version: 1,
  prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] },
  health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8 },
}, null, 2));
const mergedOld = loadConfig();
eq("old config (no maxNotesBytes) -> default 8192", mergedOld.health.maxNotesBytes, 8192);

// explicit value respected
saveConfig({ ...mergedOld, health: { ...mergedOld.health, maxNotesBytes: 4096 } });
eq("explicit maxNotesBytes 4096 respected", loadConfig().health.maxNotesBytes, 4096);

// 0 respected (strict no-notes)
saveConfig({ ...mergedOld, health: { ...mergedOld.health, maxNotesBytes: 0 } });
eq("maxNotesBytes 0 respected", loadConfig().health.maxNotesBytes, 0);

// negative -> default
writeFileSync(join(tmp, "todo.config.json"), JSON.stringify({
  version: 1,
  prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] },
  health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: -5 },
}, null, 2));
eq("negative maxNotesBytes -> default 8192", loadConfig().health.maxNotesBytes, 8192);

// non-number (string) -> default
writeFileSync(join(tmp, "todo.config.json"), JSON.stringify({
  version: 1,
  prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] },
  health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: "big" },
}, null, 2));
eq("non-number maxNotesBytes -> default 8192", loadConfig().health.maxNotesBytes, 8192);

// forward-merge: an old config (no notify) gets the default true
writeFileSync(join(tmp, "todo.config.json"), JSON.stringify({
  version: 1,
  prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] },
  health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: 8192 },
}, null, 2));
eq("old config (no notify) -> sessionStartCount default true", loadConfig().notify.sessionStartCount, true);

// explicit false respected
saveConfig({ ...loadConfig(), notify: { sessionStartCount: false } });
eq("explicit sessionStartCount false respected", loadConfig().notify.sessionStartCount, false);

// non-boolean -> default true
writeFileSync(join(tmp, "todo.config.json"), JSON.stringify({
  version: 1,
  prune: { defaultAgeDays: 7, hardAgeDays: 180, statuses: ["done", "cancelled"] },
  health: { activeMaxOpen: 15, activeStaleDays: 30, parkedMax: 10, parkedStaleDays: 60, archiveMax: 200, archiveOldDays: 180, perProjectDefaultMax: 8, maxNotesBytes: 8192 },
  notify: { sessionStartCount: "no" },
}, null, 2));
eq("non-boolean sessionStartCount -> default true", loadConfig().notify.sessionStartCount, true);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);