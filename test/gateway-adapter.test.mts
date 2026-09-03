// Gateway-adapter contract tests for armory-todo SPEC-1b-3 (node:test for skip).
// Run: node test/gateway-adapter.test.mts
// Real-module tests need ARMORY_GATEWAY_PATH (+ PR-1 merged for the bare-entry pin).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkGateway } from "./helpers/gateway-link.mts";

const tmp = mkdtempSync(join(tmpdir(), "armory-todo-adapter-"));
process.env.TODO_DIR = tmp;

const { registerGatewayVisibilityProvider } = await import("../src/gateway-adapter.ts");
const { addTodo, updateTodo } = await import("../src/todo-store.ts");

test("injected fake: provider registers and scopes from the live store", async () => {
  let received: ((input: unknown) => Promise<unknown>) | undefined;
  const fake = { registerVisibilityProvider(fn: (input: unknown) => Promise<unknown>) { received = fn; } };
  const out = await registerGatewayVisibilityProvider({ importGateway: async () => fake });
  assert.deepEqual(out, { registered: true });
  const t1 = addTodo({ title: "scoped work", tags: ["mcp:github"], project: "p" });
  updateTodo(t1.id, { status: "in_progress" });
  assert.deepEqual(await received!({}), ["github"]);
  updateTodo(t1.id, { status: "parked" });
  assert.equal(await received!({}), undefined, "no in_progress mcp: tags → undefined (pass-through)");
});

test("provider NEVER throws — store failure underneath resolves undefined + warns", async () => {
  let received: ((input: unknown) => Promise<unknown>) | undefined;
  const fake = { registerVisibilityProvider(fn: (input: unknown) => Promise<unknown>) { received = fn; } };
  await registerGatewayVisibilityProvider({
    importGateway: async () => fake,
    loadStoreFn: () => { throw new Error("store exploded"); },
  });
  const result = await received!({});
  assert.equal(result, undefined, "internal catch → undefined (never the hide-all throw path)");
});

test("import failure → { registered: false }, no throw", async () => {
  const out = await registerGatewayVisibilityProvider({ importGateway: async () => { throw new Error("module absent"); } });
  assert.deepEqual(out, { registered: false });
});

test("REAL gateway module: registration, convergence, seam-level bare-entry matcher pin", async (t) => {
  const gwPath = linkGateway();
  if (!gwPath) {
    t.skip("ARMORY_GATEWAY_PATH unset — skipping real-module contract tests (set it to the armory-gateway repo)");
    return;
  }
  const out = await registerGatewayVisibilityProvider();
  assert.deepEqual(out, { registered: true });
  const sym = Symbol.for("@getpipher/armory-gateway:registry");
  const store = (globalThis as Record<symbol, { visibility?: unknown }> | undefined)![sym];
  assert.ok(store?.visibility, "symbol-store visibility slot truthy after registration");
  const resolved = import.meta.resolve("@getpipher/armory-gateway");
  const dup = (await import(resolved + "?dup=1")) as {
    registeredKinds(): { visibility: boolean };
    scopeAllows(scope: { mode: "all" } | { mode: "list"; tools: Set<string> }, server: string, tool: string): boolean;
  };
  assert.equal(dup.registeredKinds().visibility, true, "dup instance sees the same slot");
  // V4 seam-level pin (plan-phase upgrade): the bare-entry matcher widening is real
  const scope = { mode: "list" as const, tools: new Set(["github"]) };
  assert.equal(dup.scopeAllows(scope, "github", "anything"), true, "bare entry → whole server (requires PR-1 gateway)");
  assert.equal(dup.scopeAllows(scope, "gitlab", "anything"), false);
});
