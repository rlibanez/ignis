// Data policy. Callers must supply roles
// from the authenticated session/database, never from request fields.
const roles = new Set(["reader", "editor", "owner"]);
const personalCandidates = new Set([
  "app.json", "appearance.json", "hotkeys.json", "graph.json",
  "workspace.json", "workspace-mobile.json", "workspaces.json",
]);
const instanceCapabilities = new Set([
  "users.manage", "instance.configure", "audit.read",
  "plugins.manage", "sync.manage",
]);
const ownerCapabilities = new Set([
  "members.manage", "ownership.transfer", "vault.rename", "vault.delete", "vault.refresh",
]);

// Input must already be a vault-relative, decoded, canonical path. This does
// not replace filesystem containment, symlink checks or recursive authorization.
function classifyVaultPath(value) {
  if (typeof value !== "string" || value.startsWith("/") ||
      // eslint-disable-next-line no-control-regex
      /[\\\x00-\x1f\x7f]/.test(value)) return "invalid";
  if (value === "") return "root";
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) return "invalid";
  // Case-insensitive reservation also protects deployments on case-folding disks.
  const lower = parts.map(part => part.toLowerCase());
  if (lower.some(part => part.startsWith(".ignis"))) return "reserved";
  if (lower[0] === ".obsidian") {
    if (lower.length === 2 && (personalCandidates.has(lower[1]) || /^workspace\.[a-z0-9_-]+\.json$/.test(lower[1])))
      return "personal-candidate";
    return "configuration";
  }
  // Unknown hidden state (including nested .obsidian, .git and secrets) is
  // administrative until its data contract has been reviewed explicitly.
  if (lower.some(part => part.startsWith("."))) return "configuration";
  return "content";
}

function vaultCapabilityAllowed({ status, instanceRole, membership, capability, path } = {}) {
  if (status !== "active" || !["admin", "user"].includes(instanceRole)) return false;
  if(capability === "vault.create")return true; // Ownership assignment is enforced by vault-creation.
  const admin = instanceRole === "admin";
  if (instanceCapabilities.has(capability)) return admin;
  if (ownerCapabilities.has(capability)) return membership === "owner";
  if (!["content.read", "content.write", "content.list"].includes(capability)) return false;
  const kind = classifyVaultPath(path);
  if (["invalid", "reserved"].includes(kind)) return false;
  if (kind === "root") return capability === "content.list" && roles.has(membership);
  // Shared Obsidian configuration includes community code and its settings.
  // Trust is granted to vault editors; this is not a plugin sandbox.
  const sharedConfiguration = typeof path === "string" &&
    (path === ".obsidian" || path.startsWith(".obsidian/") || path === ".OBSIDIANTEST");
  const trash = path === ".trash" || (typeof path === "string" && path.startsWith(".trash/") && classifyVaultPath(path.slice(7)) === "content");
  if (!roles.has(membership) || (kind !== "content" && !sharedConfiguration && !trash)) return false;
  return capability !== "content.write" || ["editor", "owner"].includes(membership);
}

module.exports = { classifyVaultPath, vaultCapabilityAllowed };
