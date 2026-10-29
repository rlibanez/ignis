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

it("sends the explicit owner and inspected folder identity without silently retrying conflicts", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "The directory changed" }) });
  vi.stubGlobal("fetch", fetch);
  await expect(vaultService.registerVault("Notes", "selected-owner", "selected-identity")).rejects.toThrow("directory changed");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/api/vault/register");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ directory: "Notes", ownerId: "selected-owner", identity: "selected-identity" });
});

it("sends the selected owner when creating a vault", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    .mockResolvedValueOnce({ ok: true, json: async () => [] });
  vi.stubGlobal("fetch", fetch);
  await vaultService.createVault("Owned", "selected-owner");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: "Owned", ownerId: "selected-owner" });
});

it("keeps the opened UUID even when a refreshed list reuses its name", () => {
  const current = { __ignisAuth: { userId: "test-user" }, __currentVaultId: "Notes", __currentVaultUuid: "original", __vaultList: [{ id: "Notes", uuid: "replacement" }, { id: "Other", uuid: "other-id" }], location: {} };
  current.parent = current;
  vi.stubGlobal("window", current);
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { setItem });
  expect(vaultService.referenceFor("Notes")).toBe("original");
  vaultService.openVault("Other");
  expect(current.location.href).toBe("/?vault=other-id");
  expect(setItem).toHaveBeenCalledWith("ignis:last-vault:test-user", "other-id");
});

it("isolates remembered vaults by account without importing the legacy global key", () => {
  const data = new Map([["last-vault", "foreign-legacy"]]);
  vi.stubGlobal("localStorage", { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  const auth = { userId: "alice", blocked: false };
  vi.stubGlobal("window", { __ignisAuth: auth });
  expect(vaultService.rememberedVault()).toBeNull();
  vaultService.rememberVault("alice-vault");
  auth.userId = "bob";
  expect(vaultService.rememberedVault()).toBeNull();
  vaultService.rememberVault("bob-vault");
  auth.userId = "alice";
  expect(vaultService.rememberedVault()).toBe("alice-vault");
  auth.blocked = true;
  expect(vaultService.rememberedVault()).toBeNull();
  vaultService.rememberVault("blocked-write");
  auth.blocked = false;
  expect(vaultService.rememberedVault()).toBe("alice-vault");
  auth.userId = null;
  expect(vaultService.rememberedVault()).toBeNull();
  vaultService.rememberVault("anonymous-write");
  expect(data.size).toBe(3);
});

it("keeps browser storage optional without falling back to a shared selection", () => {
  vi.stubGlobal("window", { __ignisAuth: { userId: "alice" } });
  vi.stubGlobal("localStorage", { getItem() { throw new Error("Disabled"); }, setItem() { throw new Error("Disabled"); } });
  expect(vaultService.rememberedVault()).toBeNull();
  expect(() => vaultService.rememberVault("vault")).not.toThrow();
});

it("separates browser cache and trust identities by account and stable vault reference", () => {
  const data = new Map([["enable-plugin-Notes", "true"]]);
  const auth = { userId: "alice" };
  vi.stubGlobal("window", { __ignisAuth: auth, __currentVaultId: "Notes", __currentVaultUuid: "vault-uuid" });
  vi.stubGlobal("localStorage", { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) });
  const first = vaultService.browserVaultId("vault-uuid");
  vaultService.setVaultTrust("Notes");
  expect(data.get("enable-plugin-" + first)).toBe("true");
  auth.userId = "bob";
  expect(vaultService.browserVaultId("vault-uuid")).not.toBe(first);
  expect(data.has("enable-plugin-" + vaultService.browserVaultId("vault-uuid"))).toBe(false);
  auth.userId = "alice";
  vaultService._migrateLocalStorage("Notes", "Renamed");
  expect(data.get("enable-plugin-" + first)).toBe("true");
  expect(vaultService.browserVaultId("replacement-uuid")).not.toBe(first);
  auth.blocked = true;
  expect(vaultService.browserVaultId("vault-uuid")).toBeNull();
  vaultService.setVaultTrust("Notes", false);
  expect(data.get("enable-plugin-" + first)).toBe("true");
});

it("does not collide when account and vault identifiers contain separators", () => {
  const auth = { userId: "a:b" };
  vi.stubGlobal("window", { __ignisAuth: auth });
  const first = vaultService.browserVaultId("c");
  auth.userId = "a";
  expect(vaultService.browserVaultId("b:c")).not.toBe(first);
});
