# SPEC-1b-3 — Gateway visibility provider (armory-todo, PR-3 / D3 + D4 + D5)

> Relocated from the SPEC-1b-3 staging spec (`SPEC-1b-3-memory-todo-adapters.md` §6, §7) — armory-todo's half of the memory/todo adapter slice.

## §6 — D3: Todo visibility provider (as shipped)

**`src/visibility-provider.ts` (pure, pi-independent):**

```ts
export function parseMcpTag(tag: string): { server: string; tool?: string } | null;
export function collectScopedTools(store: Store): string[] | undefined;
```

- `parseMcpTag`: `mcp:` prefix required; remainder either bare `server` or `server__tool` (first-`__` split, both parts non-empty); metacharacters `/[*?[\]]` rejected — mirrors fleet's as-built validator class. Invalid → `null`.
- `collectScopedTools`: `store.todos.filter(t => t.status === "in_progress")` → union (Set) of parsed tags → bare tags emitted as `server`, tool tags as a template `server__tool` → empty → `undefined`.
- Provider closure: `loadStore()` per call (§3.7) → `collectScopedTools`. **Internal try/catch → `undefined` + `console.warn`** on unexpected errors: the contract's throw→hide-all is the wrong failure direction for a convenience scoper (it would turn a store hiccup into a full MCP outage). Q5 governs errors *escaping* providers; this adapter handles its own and never throws — documented here as the deliberate stance.
- **Wiring (`extensions/todo.ts`):** appended to the existing `session_start` handler — guarded import, `registerVisibilityProvider(provider)`, silent skip when absent. Idempotent.

## §7 — D4 + D5: Linkage & release gates (as shipped)

- **D4** — `test/helpers/gateway-link.mts`: `linkGateway(): string | null` reads `ARMORY_GATEWAY_PATH`; unset → `null` (real-module contract test `t.skip`s with a loud notice naming the env var); set → idempotent `node_modules/@getpipher/armory-gateway` symlink → bare-specifier resolution works under plain node 24. No `package.json` dependency changes (Q4-B — public repo, no `file:` devDep).
- **D5** — `.github/workflows/release.yml`: the armory-gateway clone step sits BEFORE `npm install`, and the test step exports `ARMORY_GATEWAY_PATH: ${{ github.workspace }}/../armory-gateway`. No continue-on-error — a failed clone fails the release (fleet precedent). `SIBLINGS_PAT` is a per-repo secret on getpipher/armory-todo (RECTOR sets it; least privilege, same as fleet's).
- **D6** — README "MCP tool scoping" section (tag grammar + examples; `in_progress` semantics; union; fail-open on bad tags; the injected-block explainability note; absent-gateway = inert). No unwired claims.

## As-built notes

- V1/V2 proven 2026-09-03: bare-specifier symlink resolution under plain node 24, and `?dup=1` two-instance symbol-store convergence (real-module contract test 4/4 with `ARMORY_GATEWAY_PATH` set, no skip).
- V4 seam upgrade: plan-phase verification found `scopeAllows`/`resolveVisibilityScope` are on the gateway's public seam — `scopeAllows` IS exported, so the contract tests pin the bare-entry matcher widening SEAM-LEVEL (a `?dup=1` dup instance's `scopeAllows({mode:"list", tools:new Set(["github"])}, "github", "anything") === true` — requires gateway PR-1's widened build).
- Test-fixture note: the pairs-test `want` literal in the brief was unsorted against its own `.sort()` call (lexicographic: `github__` < `gitlab__`) — corrected test-side, production byte-verbatim (controller ratification tracked in the Task 5 report).
