// PLAN-1b-3 D4: env-gated real-module resolution for contract tests.
// ARMORY_GATEWAY_PATH unset → null (caller t.skip's with a loud notice).
// Set → idempotently symlink the gateway repo into node_modules/@getpipher/
// so the adapter's bare-specifier guarded import resolves (verified: plan V1).

import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function linkGateway(): string | null {
  const target = process.env.ARMORY_GATEWAY_PATH;
  if (!target) return null;
  const abs = resolve(target);
  if (!existsSync(abs)) return null;
  const pkgDir = join(resolve(dirname(fileURLToPath(import.meta.url))), "..", "..", "node_modules", "@getpipher");
  mkdirSync(pkgDir, { recursive: true });
  const link = join(pkgDir, "armory-gateway");
  if (!existsSync(link)) symlinkSync(abs, link, "dir");
  return abs;
}
