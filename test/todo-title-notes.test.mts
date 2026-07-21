// Suite for the title + notes schema split (Workstream B).
// Run: node test/todo-title-notes.test.mts
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "armory-tn-"));
process.env.TODO_DIR = tmp;

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name} ${extra}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  ok(name, got === want, `(got ${JSON.stringify(got)} want ${JSON.stringify(want)})`);
}

const { addTodo, updateTodo, getTodo, listTodos, renderOpenBlock, loadStore } =
  await import("../src/todo-store.ts");
const { splitTextFallback } = await import("../src/migrate.ts");

// --- add: title only, notes defaults to "" ---
const t1 = addTodo({ title: "Write SPEC-2", project: "pi", priority: "high", source: "test" });
eq("add title set", t1.title, "Write SPEC-2");
eq("add notes defaults empty", t1.notes, "");
eq("add status open", t1.status, "open");

// --- add: title + notes ---
const t2 = addTodo({ title: "Ship v0.3.0", notes: "Migration first, then panel, then health." });
eq("add notes set", t2.notes, "Migration first, then panel, then health.");

// --- add: trims title before length check ---
const t3 = addTodo({ title: "  trimmed title  " });
eq("add trims title", t3.title, "trimmed title");

// --- add: rejects empty title ---
let threw = false;
try { addTodo({ title: "   " } as any); } catch { threw = true; }
ok("add rejects blank title", threw);

// --- add: rejects title > 120 ---
threw = false;
try { addTodo({ title: "x".repeat(121) }); } catch { threw = true; }
ok("add rejects 121-char title", threw);
const ok120 = addTodo({ title: "y".repeat(120) });
eq("add accepts exactly 120 chars", ok120.title.length, 120);

// --- update: title + notes ---
updateTodo(t1.id, { title: "Write SPEC-2 + SPEC-3", notes: "Block Tuesday for it." });
const t1b = getTodo(t1.id);
eq("update title", t1b.title, "Write SPEC-2 + SPEC-3");
eq("update notes", t1b.notes, "Block Tuesday for it.");

// --- update: notes="" clears ---
updateTodo(t1.id, { notes: "" });
eq("update notes empty clears", getTodo(t1.id).notes, "");

// --- update: rejects title > 120 ---
threw = false;
try { updateTodo(t1.id, { title: "z".repeat(121) }); } catch { threw = true; }
ok("update rejects 121-char title", threw);

// --- get: missing id throws ---
threw = false;
try { getTodo("td-nonexistent"); } catch { threw = true; }
ok("get missing id throws", threw);

// --- list: text filter matches title OR notes ---
addTodo({ title: "unrelated title", notes: "special-token-xyz" });
addTodo({ title: "findme-abc title", notes: "" });
const byNotes = listTodos({ text: "special-token-xyz" });
ok("list text filter matches notes", byNotes.some((t) => t.notes.includes("special-token-xyz")));
const byTitle = listTodos({ text: "findme-abc" });
ok("list text filter matches title", byTitle.some((t) => t.title.includes("findme-abc")));

// --- renderOpenBlock: title only, never notes; dot when notes present ---
const block = renderOpenBlock();
ok("renderOpenBlock includes a title", block.includes("findme-abc"));
ok("renderOpenBlock never includes notes content", !block.includes("special-token-xyz"));
ok("renderOpenBlock has dot for notes-bearing todo", block.includes("•"));

// --- v2→v3 inline derivation on load (fallback, no curated map yet) ---
{
  const dir2 = mkdtempSync(join(tmpdir(), "armory-tn-v2-"));
  const file = join(dir2, "todo.json");
  writeFileSync(file, JSON.stringify({
    version: 2,
    updatedAt: "2026-07-20T10:00:00Z",
    todos: [{
      id: "td-v2-1", text: "First line is the title\nbody detail here",
      project: "", tags: [], priority: "med", status: "open", source: "",
      createdAt: "2026-07-20T10:00:00Z", updatedAt: "2026-07-20T10:00:00Z", closedAt: null,
    }],
  }), "utf8");
  process.env.TODO_DIR = dir2;
  const store = loadStore();
  eq("v2→v3 inline: version 3", store.version, 3);
  eq("v2→v3 inline: title from first line", store.todos[0]!.title, "First line is the title");
  eq("v2→v3 inline: notes from remainder", store.todos[0]!.notes, "body detail here");
  ok("v2→v3 inline: no text field on todo", !("text" in store.todos[0]!));
  process.env.TODO_DIR = tmp;
  rmSync(dir2, { recursive: true, force: true });
}

// --- splitTextFallback unit cases ---
const s1 = splitTextFallback("one liner");
eq("split: single line ≤120 → title=whole, notes=''", s1.title, "one liner");
eq("split: single line notes empty", s1.notes, "");
const s2 = splitTextFallback("first\nsecond\nthird");
eq("split: multiline title=first line", s2.title, "first");
eq("split: multiline notes=rest joined", s2.notes, "second\nthird");
const long = "w".repeat(200);
const s3 = splitTextFallback(long);
ok("split: overlong single-line title ≤120", s3.title.length <= 120);
eq("split: overlong single-line notes=full original", s3.notes, long);
const s4 = splitTextFallback("first line is way too long " + "x".repeat(200) + "\nrest");
ok("split: overlong first-line title ≤120", s4.title.length <= 120);
ok("split: overlong first-line notes starts with full first line", s4.notes.startsWith("first line is way too long "));
ok("split: overlong first-line notes includes rest", s4.notes.endsWith("rest"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);