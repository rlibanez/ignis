// Project messages per recipient. Never forward unknown payload fields.
function projectVaultEvent(message, { canRead, canAdmin }) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  if (message.channel === "metadata") {
    // Global revisions can reveal activity in hidden resources. Until per-view
    // revisions exist, only administrators receive this global channel.
    return canAdmin("instance.configure") && ["revision", "replaced"].includes(message.type) && typeof message.etag === "string"
      ? { channel: "metadata", type: message.type, etag: message.etag } : null;
  }
  if (message.channel === "plugin:headless-sync")
    return canAdmin("sync.manage") && ["sync-log", "sync-status"].includes(message.type) ? message : null;
  if (message.channel) return null;
  if (["virtual-plugin-enable", "virtual-plugin-disable"].includes(message.type))
    return canAdmin("plugins.manage") ? message : null;
  if (!["created", "modified", "deleted", "folder-created", "rename", "write-giveup"].includes(message.type)) return null;
  const visible = typeof message.path === "string" && canRead(message.path);
  let projected;
  if (message.type === "rename") {
    if (typeof message.toPath !== "string") return null;
    const destinationVisible = canRead(message.toPath);
    if (!visible && !destinationVisible) return null;
    if (visible && destinationVisible) projected = { type: "rename", path: message.path, toPath: message.toPath };
    else if (visible) return { type: "deleted", path: message.path };
    else projected = { type: message.stat?.type === "directory" ? "folder-created" : "created", path: message.toPath };
  } else {
    if (!visible) return null;
    projected = { type: message.type, path: message.path };
  }
  if (message.stat && typeof message.stat === "object") {
    const stat = {};
    if (["file", "directory"].includes(message.stat.type)) stat.type = message.stat.type;
    for (const key of ["size", "mtime", "ctime"])
      if (typeof message.stat[key] === "number" && Number.isFinite(message.stat[key]) && message.stat[key] >= 0) stat[key] = message.stat[key];
    if (Object.keys(stat).length) projected.stat = stat;
  }
  return projected;
}
module.exports = { projectVaultEvent };
