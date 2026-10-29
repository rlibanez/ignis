import { afterEach, it, expect, vi } from "vitest";
import { vaultService } from "./vault-service.js";
afterEach(() => vi.unstubAllGlobals());
it("deletes the UUID selected in the dialog even if the cached name now belongs to another vault", async () => {
  vi.stubGlobal("window", { __currentVaultId: "Notes", __vaultList: [{ id: "Notes", uuid: "replacement" }] });
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, cleanupPending: true }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [] });
  vi.stubGlobal("fetch", fetch);
  expect(await vaultService.deleteVault("Notes", "selected-uuid")).toEqual({ wasCurrentVault: true, cleanupPending: true });
  expect(fetch.mock.calls[0]).toEqual(["/api/vault/remove?vault=selected-uuid", { method: "DELETE" }]);
});
it("does not silently refresh an outdated selector or retry a refused deletion", async () => {
  vi.stubGlobal("window", { __currentVaultId: "Other" });
  const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Vault already removed" }) });
  vi.stubGlobal("fetch", fetch);
  await expect(vaultService.deleteVault("Notes", "old-uuid")).rejects.toThrow("Vault already removed");
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("keeps the name selector only for an unregistered legacy vault", async () => {
  vi.stubGlobal("window", { __currentVaultId: "Other" });
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [] });
  vi.stubGlobal("fetch", fetch);
  expect(await vaultService.deleteVault("Legacy")).toEqual({ wasCurrentVault: false, cleanupPending: false });
  expect(fetch.mock.calls[0][0]).toBe("/api/vault/remove?vault=Legacy");
});
