const fs = require("node:fs/promises");
const path = require("node:path");

function permit(req, root, absolute, capability) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  return !req.authorizeVaultFile || req.authorizeVaultFile(req._vaultId, capability, relative);
}

// Complete preflight before a recursive mutation; never mutate a partly allowed tree.
async function permitSubtree(req, root, source, capability, destination = null) {
  if (!permit(req, root, source, capability) ||
      (destination && !permit(req, root, destination, "content.write"))) return false;
  let stat;
  try { stat = await fs.lstat(source); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  if (stat.isSymbolicLink()) return false;
  if (!stat.isDirectory()) return true;
  for (const entry of await fs.readdir(source)) {
    if (!await permitSubtree(req, root, path.join(source, entry), capability,
      destination ? path.join(destination, entry) : null)) return false;
  }
  return true;
}

function filterTree(req, root, tree) {
  return Object.fromEntries(Object.entries(tree).filter(([relative, entry]) =>
    permit(req, root, path.join(root, relative), entry.type === "directory" ? "content.list" : "content.read")));
}
module.exports = { permit, permitSubtree, filterTree };
