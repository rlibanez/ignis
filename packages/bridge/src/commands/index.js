import { registerOpenWorkspace } from "./open-workspace.js";
import { registerRefreshVault } from "./refresh-vault.js";

function registerCommands(plugin) {
  const auth = window.__ignisAuth;
  if (auth?.blocked || !["admin", "user"].includes(auth?.role)) return;
  registerOpenWorkspace(plugin);
  // Server authorization remains authoritative if membership changes later.
  const membership = window.__ignis?.vault?.membership;
  if (membership === "owner" || (auth.role === "admin" && !window.__ignis?.vault?.uuid))
    registerRefreshVault(plugin);
}

export { registerCommands };
