// Gateway adapter for armory-todo (SPEC-1b-3 D3): registers a VisibilityProvider
// against @getpipher/armory-gateway's IoC registry. The specifier is NEVER
// statically imported — guarded dynamic import keeps public-npm installs standalone.
// Absent gateway → { registered: false }, silent (the normal public state).

import { loadStore, type Store } from "./todo-store.ts";
import { collectScopedTools } from "./visibility-provider.ts";

export interface GatewayModuleLike {
  registerVisibilityProvider(fn: (input: { agent?: string; task?: string }) => Promise<string[] | null | undefined>): void;
}

export interface GatewayAdapterDeps {
  importGateway?: () => Promise<GatewayModuleLike>;
  loadStoreFn?: () => Store;
}

export async function registerGatewayVisibilityProvider(
  deps: GatewayAdapterDeps = {},
): Promise<{ registered: boolean }> {
  let gw: GatewayModuleLike;
  try {
    gw = await (deps.importGateway ?? (() => import("@getpipher/armory-gateway")))();
  } catch {
    return { registered: false };
  }
  const load = deps.loadStoreFn ?? loadStore;
  // Deliberate stance (SPEC-1b-3 §6): this adapter handles its own errors and
  // never throws. The contract's throw→hide-all is the wrong failure direction
  // for a convenience scoper — an internal error passes through unscoped instead.
  gw.registerVisibilityProvider(async () => {
    try {
      return collectScopedTools(load());
    } catch (err) {
      console.warn(`armory-todo: visibility provider error — passing through unscoped: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  });
  return { registered: true };
}
