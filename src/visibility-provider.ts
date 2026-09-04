// Pure, pi-independent MCP tool-scoping for armory-todo (SPEC-1b-3 D3).
//
// Convention: tags on in_progress todos matching mcp:<server> or
// mcp:<server>__<tool> scope the session's MCP tools (gateway visibility
// contract). Invalid mcp: tags are skipped SILENTLY — a typo means LESS
// narrowing, never more (scoping is the convenience plane; fleet's mcpDeny
// is the security plane). The injected TODO block makes the scoping state
// self-explanatory in every session.
//
// Kept free of any pi/typebox imports so it can be unit-tested standalone.

import type { Store } from "./todo-store.ts";

export interface ScopedToolTag {
  server: string;
  tool?: string;
}

/** Parse one tag. Returns null for anything that is not exactly the convention
 *  (missing mcp: prefix, empty parts, glob metacharacters /[*?[\]]/ — mirrors
 *  fleet's mcpDeny validator class). a__b__c parses as server=a, tool=b__c
 *  (first-__ split; harmless — gateway tool names never contain __). */
export function parseMcpTag(tag: string): ScopedToolTag | null {
  if (!tag.startsWith("mcp:")) return null;
  const rest = tag.slice(4);
  if (!rest || /[*?[\]]/.test(rest)) return null;
  const idx = rest.indexOf("__");
  if (idx === -1) return { server: rest };
  const server = rest.slice(0, idx);
  const tool = rest.slice(idx + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

/** Union of mcp: tags across ALL in_progress todos. Non-empty → prefixed names
 *  (bare servers emitted bare — gateway's 1b-3 matcher scopes them whole-server);
 *  none → undefined (not applicable → config-only pass-through). */
export function collectScopedTools(store: Store): string[] | undefined {
  const names = new Set<string>();
  for (const todo of store.todos) {
    if (todo.status !== "in_progress") continue;
    for (const tag of todo.tags ?? []) {
      const parsed = parseMcpTag(tag);
      if (!parsed) continue;
      names.add(parsed.tool ? `${parsed.server}__${parsed.tool}` : parsed.server);
    }
  }
  return names.size > 0 ? [...names] : undefined;
}
