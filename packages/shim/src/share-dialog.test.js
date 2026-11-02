import { expect, it, vi } from "vitest";
import { openShareDialog } from "./share-dialog.js";
function setup() {
  const host = { __ignisAuth: { sessionId: "session" }, __currentVaultUuid: "vault", __ignisOpenResourceSharing: vi.fn() };
  const reload = vi.fn();
  const app = { workspace: { getLeavesOfType: () => [{ view: { reload } }] } };
  const shared = { refresh: vi.fn() };
  const Notice = vi.fn();
  openShareDialog({ Notice }, app, { path: "folder/note.md" }, shared, host);
  return { host, options: host.__ignisOpenResourceSharing.mock.calls[0][0], reload, shared, Notice };
}
it("opens the common manager with the selected resource and refreshes after mutations", async () => {
  const { options, shared, reload } = setup();
  expect(options.initialResource).toEqual({ vault: "vault", path: "folder/note.md", session: "session" });
  expect(shared.refresh).not.toHaveBeenCalled();
  await options.onMutation();
  expect(shared.refresh).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
});
it.each(["session", "vault", "blocked"])("rejects a changed %s context", kind => {
  const { host, options } = setup();
  if (kind === "session") host.__ignisAuth.sessionId = "another";
  if (kind === "vault") host.__currentVaultUuid = "another";
  if (kind === "blocked") host.__ignisAuth.blocked = true;
  expect(options.assertContext).toThrow(/session or vault changed/);
});
it("does not report a saved mutation as failed when display refresh fails", async () => {
  const { options, shared, Notice } = setup();
  shared.refresh.mockRejectedValue(new Error("offline"));
  await expect(options.onMutation()).resolves.toBeUndefined();
  expect(Notice).toHaveBeenCalledOnce();
});
