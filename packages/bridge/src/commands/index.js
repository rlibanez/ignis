import { registerOpenWorkspace } from "./open-workspace.js";
import { registerRefreshVault } from "./refresh-vault.js";

function registerCommands(plugin) {
  if (window.__ignisAuth?.role === "admin") {
    registerOpenWorkspace(plugin);
    registerRefreshVault(plugin);
  }
}

export { registerCommands };
