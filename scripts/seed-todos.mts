// One-time seed of known open cross-session TODOs into the real store.
// Idempotent: skips items whose text already exists. Run: node scripts/seed-todos.mts
import { addTodo, listTodos, loadStore } from "../src/todo-store.ts";

const seed = [
  { text: "Decouple global rules from CLAUDE.md → per-host AGENTS.md (CC→dotfiles/claude, Pi→dotfiles/pi, split + small shared/ include for identity/values)", project: "pi", tags: ["dotfiles", "config"], priority: "high" as const, source: "pi-handoff#7" },
  { text: "Research browser-use vs CC native Chrome MCP → pick Pi browser-automation stack (reuse if open+portable, else browser-use via pi-mcp-adapter/armory bridge)", project: "pi", tags: ["browser", "research"], priority: "med" as const, source: "pi-handoff#8" },
  { text: "Pi feature: mid-message skill/slash-command invocation (file upstream feature on earendil-works/pi, or prototype in armory if extension-possible)", project: "pi", tags: ["upstream", "skill"], priority: "med" as const, source: "pi-handoff#9" },
  { text: "Memory migration: ~/.claude/projects/.../memory/ → ~/.pi/agent/memory/<context>/; migrate hackathon/upwork memory files + repoint skills", project: "pi", tags: ["memory", "migration"], priority: "med" as const, source: "pi-handoff#3" },
  { text: ".claude/ path normalization in 3 arsenal-private skills (superteam/bounty-agent, hackathon/research, upwork/bid) → ~/.pi/agent/", project: "pi", tags: ["arsenal", "cleanup"], priority: "low" as const, source: "pi-handoff#5" },
  { text: "browser-use bridge in armory (depends on browser-use research #8); restores browser automation for upwork/bid + quality/qa", project: "pi", tags: ["armory", "browser"], priority: "low" as const, source: "pi-handoff#6" },
];

const existing = loadStore();
const existingTexts = new Set(existing.todos.map((t) => t.text));
let added = 0;
for (const s of seed) {
  if (existingTexts.has(s.text)) {
    console.log(`skip (exists): ${s.text.slice(0, 60)}…`);
    continue;
  }
  const t = addTodo(s);
  console.log(`added ${t.id}: ${s.text.slice(0, 60)}…`);
  added++;
}
console.log(`\nSeeded ${added} new TODO(s). Open now: ${listTodos().length}`);
console.log(`Store: ${process.env.TODO_STORE_PATH || "~/.pi/agent/todo.json (default)"}`);