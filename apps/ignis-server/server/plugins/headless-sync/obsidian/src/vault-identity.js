// Sync state keys use the server-owned directory ID; the API converts the current
// directory to its pinned UUID. Obsidian's getName() is only a display label.
function currentVaultId() {
  const id = typeof window === 'undefined' ? null : window.__ignis?.vault?.id;
  if (typeof id !== 'string' || !id) throw new Error('Authenticated vault identity required');
  return id;
}
module.exports = {currentVaultId};
