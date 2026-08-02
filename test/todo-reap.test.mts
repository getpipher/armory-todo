import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { addTodo, updateTodo, listTodos, getTodo, loadStore, saveStore, type Todo, type Store } from "../src/todo-store.ts";
import { reapStaleActive, type ReapResult } from "../src/reap.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { getLivePath, getConfigPath } from "../src/paths.ts";

const TMP = `${import.meta.dirname}/tmp-reap`;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.TODO_DIR = TMP;
});
afterEach(() => {
  delete process.env.TODO_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

const DAY = 86_400_000;

/** Create a todo, backdate it to simulate staleness. */
function staleTodo(source: string, ageDays: number, title = "stale run"): string {
  const t = addTodo({ title, source });
  const ts = new Date(Date.now() - ageDays * DAY).toISOString();
  const s = loadStore();
  const row = s.todos.find((x) => x.id === t.id)!;
  row.updatedAt = ts;
  row.createdAt = ts;
  saveStore(s);
  return t.id;
}

/** Backdate a todo's updatedAt by ageDays (re-stale after an updateTodo resets it). */
function backdate(id: string, ageDays: number): void {
  const ts = new Date(Date.now() - ageDays * DAY).toISOString();
  const s = loadStore();
  const row = s.todos.find((x) => x.id === id)!;
  row.updatedAt = ts;
  row.createdAt = ts;
  saveStore(s);
}

describe("reapStaleActive", () => {
  it("cancels a fleet-source active todo older than 2d", () => {
    const id = staleTodo("armory-fleet", 3);
    const res = reapStaleActive()!;
    assert.equal(res.reaped, 1);
    assert.deepEqual(res.ids, [id]);
    assert.equal(getTodo(id).status, "cancelled");
    assert.ok(getTodo(id).closedAt);
  });

  it("does NOT cancel a fleet todo younger than 2d", () => {
    const id = staleTodo("armory-fleet", 1);
    const res = reapStaleActive();
    assert.equal(res, null);
    assert.equal(getTodo(id).status, "open");
  });

  it("does NOT cancel a real (no-source) todo even at 20d", () => {
    const id = staleTodo("", 20);
    const res = reapStaleActive();
    assert.equal(res, null);
    assert.equal(getTodo(id).status, "open");
  });

  it("flags (count only) non-policy-source todos older than orphanFlagAfterDays", () => {
    staleTodo("", 16);
    const res = reapStaleActive();
    assert.equal(res, null);
  });

  it("is reversible — restore brings a reaped todo back as open", () => {
    const id = staleTodo("armory-fleet", 3);
    reapStaleActive();
    assert.equal(getTodo(id).status, "cancelled");
    updateTodo(id, { status: "open" });
    assert.equal(getTodo(id).status, "open");
  });

  it("writes an audit-log REAP line on reap", () => {
    staleTodo("armory-fleet", 3);
    staleTodo("armory-fleet", 4);
    const res = reapStaleActive()!;
    assert.equal(res.reaped, 2);
    const log = readFileSync(`${TMP}/todo-audit.log`, "utf8");
    assert.ok(/REAP/.test(log));
  });

  it("is idempotent — second call in same session reaps nothing", () => {
    staleTodo("armory-fleet", 3);
    const first = reapStaleActive()!;
    assert.equal(first.reaped, 1);
    const second = reapStaleActive();
    assert.equal(second, null);
  });

  it("skips silently on corrupt store (no crash, no reap)", () => {
    writeFileSync(getLivePath(), "{not json");
    const res = reapStaleActive();
    assert.equal(res, null);
  });

  it("respects a custom policy threshold from config", () => {
    const cfg = loadConfig();
    cfg.reap.policy["armory-fleet"].reapAfterDays = 5;
    saveConfig(cfg);
    const id = staleTodo("armory-fleet", 3);
    const res = reapStaleActive();
    assert.equal(res, null);
    assert.equal(getTodo(id).status, "open");
  });

  it("reaps in_progress todos too — in_progress is also active and reaped", () => {
    const id = staleTodo("armory-fleet", 3);
    updateTodo(id, { status: "in_progress" });
    backdate(id, 3);  // re-stale after updateTodo resets updatedAt
    const res = reapStaleActive()!;
    assert.equal(res.reaped, 1);
    assert.equal(getTodo(id).status, "cancelled");
  });

  it("oldestDays reflects updatedAt stale-age (not createdAt), post-mutation-safe", () => {
    const t = addTodo({ title: "fleet run", source: "armory-fleet" });
    const s = loadStore();
    const row = s.todos.find((x) => x.id === t.id)!;
    const tenDaysAgo = new Date(Date.now() - 10 * DAY).toISOString();
    const threeDaysAgo = new Date(Date.now() - 3 * DAY).toISOString();
    row.createdAt = tenDaysAgo;
    row.updatedAt = threeDaysAgo;
    saveStore(s);
    const res = reapStaleActive()!;
    assert.equal(res.reaped, 1);
    assert.equal(res.oldestDays, 3, `oldestDays should be updatedAt-age (3), got ${res.oldestDays}`);
  });
});