// Suite for v0.5.1 write-audit + backup (post data-loss hardening).
// Run: node test/todo-backup.test.mts
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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

const tmp = mkdtempSync(join(tmpdir(), "armory-bak-"));
process.env.TODO_DIR = tmp;

const { backupFile, snapshotOnDrop, appendAudit, countTodosInFile } = await import("../src/backup.ts");
const { saveStore, loadStore, addTodo, deleteTodo } = await import("../src/todo-store.ts");
const { saveArchive, loadArchive } = await import("../src/archive.ts");
import type { Todo } from "../src/todo-store.ts";

const fresh = new Date().toISOString();
const mk = (id: string): Todo => ({ id, title: id, notes: "", project: "", tags: [], priority: "med", status: "open", source: "", createdAt: fresh, updatedAt: fresh, closedAt: null });

console.log("== v0.5.1 write-audit + backup ==");

// --- backupFile ---
const live = join(tmp, "todo.json");
eq("countTodosInFile missing → 0", countTodosInFile(live), 0);
ok("backupFile missing file → false (no-op)", !backupFile(live));

// seed a store via saveStore (which now backs up — but no prior file, so no .bak yet)
saveStore({ version: 3, updatedAt: fresh, todos: [mk("a"), mk("b"), mk("c")] });
eq("after first save: 3 todos", countTodosInFile(live), 3);
// a second save → .bak should now hold the previous (3-todo) state
saveStore({ version: 3, updatedAt: fresh, todos: [mk("a"), mk("b"), mk("c"), mk("d")] });
ok("rolling .bak exists after 2nd save", existsSync(`${live}.bak`));
eq(".bak holds the PREVIOUS (3-todo) state", countTodosInFile(`${live}.bak`), 3);
eq("live now has 4", countTodosInFile(live), 4);

// --- snapshotOnDrop (the trap) ---
// simulate a wipe: save a 1-todo store (drop from 4 → 1)
const before = countTodosInFile(live);
const snap = snapshotOnDrop(live, before, 1);
ok("drop detected → snapshot taken", snap !== null);
ok("snapshot file exists (preserved, timestamped)", snap !== null && existsSync(snap));
eq("snapshot holds the PRE-drop (4-todo) state", snap ? countTodosInFile(snap) : -1, 4);
// growth: no snapshot
ok("growth → no snapshot", snapshotOnDrop(live, 1, 5) === null);
// steady: no snapshot
ok("steady → no snapshot", snapshotOnDrop(live, 5, 5) === null);

// --- appendAudit ---
appendAudit("todo", 4, 1, snap);
const logPath = join(tmp, "todo-audit.log");
ok("audit log created", existsSync(logPath));
const logContent = readFileSync(logPath, "utf8");
ok("audit line has save + box", logContent.includes("save todo.json"));
ok("audit line has before→after", logContent.includes("4→1"));
ok("audit line flags DROP", logContent.includes("⚠ DROP"));
ok("audit line names the snapshot", logContent.includes("snap=") && logContent.includes(".bak-drop-"));
// growth audit (no flag)
appendAudit("todo", 1, 5, null);
const log2 = readFileSync(logPath, "utf8").trim().split("\n");
ok("growth audit line has no DROP flag", !log2[log2.length - 1]!.includes("DROP"));
ok("growth audit line has +delta", log2[log2.length - 1]!.includes("+4"));

// --- integration: a real wipe via saveStore triggers backup + drop-snapshot + audit ---
// reset the store to 5 todos
saveStore({ version: 3, updatedAt: fresh, todos: [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")] });
eq("integration: 5 todos seeded", countTodosInFile(live), 5);
// now wipe via saveStore (simulate the migration-bug style drop to 1)
saveStore({ version: 3, updatedAt: fresh, todos: [mk("only")] });
eq("integration: live now 1 (wiped)", countTodosInFile(live), 1);
ok("integration: .bak holds pre-wipe 5-todo state", countTodosInFile(`${live}.bak`) === 5);
// a drop-snapshot from this save exists (timestamped) holding 5
const dropSnaps = (await import("node:fs")).readdirSync(tmp).filter((n) => n.startsWith("todo.json.bak-drop-"));
ok("integration: at least one .bak-drop-<ts> exists", dropSnaps.length > 0);
const recovered = countTodosInFile(join(tmp, dropSnaps[dropSnaps.length - 1]!));
eq("integration: newest drop-snapshot holds the 5-todo pre-wipe state", recovered, 5);
// audit log recorded the drop
const log3 = readFileSync(logPath, "utf8");
ok("integration: audit log has a 5→1 DROP line", /5→1.*⚠ DROP/.test(log3) || /5→1 -4.*DROP/.test(log3));

// --- addTodo/deleteTodo path also audited (not just direct saveStore) ---
const linesBefore = readFileSync(logPath, "utf8").trim().split("\n").length;
addTodo({ title: "via addTodo" });
deleteTodo(loadStore().todos[loadStore().todos.length - 1]!.id);
const linesAfter = readFileSync(logPath, "utf8").trim().split("\n").length;
ok("addTodo + deleteTodo each appended an audit line", linesAfter >= linesBefore + 1);

// --- saveArchive also backs up + audits ---
const arch = join(tmp, "todo-archive.json");
saveArchive({ version: 3, updatedAt: fresh, todos: [mk("x"), mk("y")] });
saveArchive({ version: 3, updatedAt: fresh, todos: [mk("x"), mk("y"), mk("z")] });
ok("archive .bak exists", existsSync(`${arch}.bak`));
eq("archive .bak holds previous (2) state", countTodosInFile(`${arch}.bak`), 2);
ok("audit log has archive lines", readFileSync(logPath, "utf8").includes("save archive.json"));

// --- v0.5.2: wipe-alert sentinel (one-shot) ---
const { writeWipeAlert, readAndClearWipeAlert } = await import("../src/backup.ts");
const { existsSync: exists2 } = await import("node:fs");
// clear any alert left by the integration drop-save above, then start clean
readAndClearWipeAlert();
// no alert initially
eq("no alert initially", readAndClearWipeAlert(), null);
// write one (a drop)
writeWipeAlert(9, 2, "/x/y/todo.json.bak-drop-2026-07-21T07-36-07-656Z");
ok("alert file exists after write", exists2(join(tmp, ".wipe-alert")));
const alert1 = readAndClearWipeAlert();
ok("alert read: before=9", alert1 !== null && alert1!.before === 9);
ok("alert read: after=2", alert1 !== null && alert1!.after === 2);
ok("alert read: snap is basename", alert1 !== null && alert1!.snap === "todo.json.bak-drop-2026-07-21T07-36-07-656Z");
// one-shot: reading cleared it
eq("alert cleared after read (one-shot)", readAndClearWipeAlert(), null);
ok("alert file gone after read", !exists2(join(tmp, ".wipe-alert")));
// growth does NOT write an alert (only drops)
// (simulate: saveStore with growth — but saveStore only calls writeWipeAlert on drop.
//  verify the helper isn't called on growth by checking no alert after a growth save)
saveStore({ version: 3, updatedAt: fresh, todos: [mk("a"), mk("b"), mk("c"), mk("d"), mk("e"), mk("f"), mk("g")] });
ok("growth save did NOT create a wipe-alert", !exists2(join(tmp, ".wipe-alert")));
// a drop save DOES create the alert
saveStore({ version: 3, updatedAt: fresh, todos: [mk("only-again")] });
ok("drop save created a wipe-alert", exists2(join(tmp, ".wipe-alert")));
const alert2 = readAndClearWipeAlert();
ok("drop-save alert: before=7 after=1", alert2 !== null && alert2!.before === 7 && alert2!.after === 1);

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
