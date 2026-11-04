
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
// The catalog controls UI availability; the server authorizes every operation.
export function openShareDialog(obsidian, app, file, sharedFiles, host = window) {
  const session = host.__ignisAuth?.sessionId;
  const vault = host.__currentVaultUuid;
  const path = file.path;
  const check = () => {
    if (!session || !vault || host.__ignisAuth?.blocked || host.__ignisAuth?.sessionId !== session || host.__currentVaultUuid !== vault)
      throw new Error(translateIgnis("Your session or vault changed. Reopen the sharing dialog."));
  };
  check();
  return host.__ignisOpenResourceSharing({
    initialResource: { vault, path, session },
    assertContext: check,
    onMutation: async () => {
      try {
        await sharedFiles.refresh();
        for (const leaf of app.workspace.getLeavesOfType("ignis-shared-resources")) await leaf.view.reload?.();
      } catch {
        new obsidian.Notice(translateIgnis("Sharing updated. Refresh Shared to update its display."));
      }
    },
  });
}
