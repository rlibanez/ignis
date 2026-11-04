import { it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const api = require("./api");
afterEach(() => vi.unstubAllGlobals());
it("uses the pinned UUID for sync actions and logs without changing remote vault IDs", async () => {
  vi.stubGlobal("window", { __ignis: { vault: { id: "Notes", uuid: "opened-uuid" } } });
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  await api.setupSync("Notes", "remote-id", { vaultId: "injected" });
  expect(JSON.parse(fetch.mock.calls.at(-1)[1].body)).toMatchObject({ vaultId: "opened-uuid", remoteVault: "remote-id" });
  await api.setConfig("Notes", { vaultId: "injected", mode: "bidirectional" });
  expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).vaultId).toBe("opened-uuid");
  for (const operation of [api.startSync, api.stopSync, api.unlinkVault]) {
    await operation("Notes");
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).vaultId).toBe("opened-uuid");
  }
  await api.getLogs("Notes");
  expect(fetch.mock.calls.at(-1)[0]).toContain("vaultId=opened-uuid");
  await api.startSync("Legacy");
  expect(JSON.parse(fetch.mock.calls.at(-1)[1].body).vaultId).toBe("Legacy");
});
