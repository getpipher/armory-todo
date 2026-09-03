// Pure visibility-provider tests for armory-todo SPEC-1b-3 (run: node test/visibility-provider.test.mts).
// Uses TODO_DIR to avoid touching the real store.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "armory-todo-vis-"));
process.env.TODO_DIR = tmp;

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

const { parseMcpTag, collectScopedTools } = await import("../src/visibility-provider.ts");
const { addTodo, updateTodo, loadStore } = await import("../src/todo-store.ts");

// --- parseMcpTag grammar ---
eq("bare server", JSON.stringify(parseMcpTag("mcp:github")), JSON.stringify({ server: "github" }));
eq("server__tool pair", JSON.stringify(parseMcpTag("mcp:github__create_issue")), JSON.stringify({ server: "github", tool: "create_issue" }));
eq("missing prefix → null", parseMcpTag("github"), null);
eq("empty rest → null", parseMcpTag("mcp:"), null);
eq("glob star → null", parseMcpTag("mcp:github__*"), null);
eq("glob question → null", parseMcpTag("mcp:g?hub"), null);
eq("bracket → null", parseMcpTag("mcp:gh[x]"), null);
eq("empty server part → null", parseMcpTag("mcp:__tool"), null);
eq("empty tool part → null", parseMcpTag("mcp:server__"), null);
eq("first-__ split: a__b__c → server a, tool b__c (harmless, never matches)",
  JSON.stringify(parseMcpTag("mcp:a__b__c")), JSON.stringify({ server: "a", tool: "b__c" }));

// --- collectScopedTools over a real store ---
eq("no todos → undefined", collectScopedTools({ version: 3, updatedAt: "", todos: [] }), undefined);

const inProg = addTodo({ title: "hunt", tags: ["mcp:github"], project: "p" });
updateTodo(inProg.id, { status: "in_progress" });
eq("in_progress + bare tag → [server]", JSON.stringify(collectScopedTools(loadStore())), JSON.stringify(["github"]));

updateTodo(inProg.id, { tags: ["mcp:github__create_issue", "mcp:gitlab__merge"] });
eq("in_progress + pairs → prefixed names",
  JSON.stringify(collectScopedTools(loadStore()).sort()),
  JSON.stringify(["github__create_issue", "gitlab__merge"]));  // lexicographic: "github" < "gitlab"

const second = addTodo({ title: "second", tags: ["mcp:nanuqfi"], project: "p" });
updateTodo(second.id, { status: "in_progress" });
const union = collectScopedTools(loadStore())!;
ok("union across in_progress todos", union.includes("nanuqfi") && union.includes("github__create_issue"));

updateTodo(second.id, { status: "parked" });
ok("parked todo's tags drop out", !collectScopedTools(loadStore())!.includes("nanuqfi"));

const done = addTodo({ title: "done one", tags: ["mcp:shouldnotcount"], project: "p" });
updateTodo(done.id, { status: "done" });
ok("done todos never scope", !JSON.stringify(collectScopedTools(loadStore())).includes("shouldnotcount"));

const invalid = addTodo({ title: "bad tags", tags: ["mcp:github__*", "notmcp:x"], project: "p" });
updateTodo(invalid.id, { status: "in_progress" });
updateTodo(inProg.id, { status: "parked" });
eq("only invalid tags → undefined (fail-open, not [])", collectScopedTools(loadStore()), undefined);

console.log(`\nvisibility-provider: ${passed} passed, ${failed} failed`);
rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
