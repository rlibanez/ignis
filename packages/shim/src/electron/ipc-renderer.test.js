import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ipcRenderer } from "./ipc-renderer.js";

let proxied;

beforeEach(() => {
  proxied = [];

  globalThis.window = {
    location: { origin: "https://ignis.test" },
    __originalFetch: async (url, opts) => {
      proxied.push(JSON.parse(opts.body));

      return {
        ok: true,
        json: async () => ({ status: 200, headers: {}, body: "" }),
      };
    },
  };
});

afterEach(() => {
  delete globalThis.window;
  vi.restoreAllMocks();
});

function requestUrl(request) {
  return new Promise((resolve) => {
    ipcRenderer.once("req-1", (event, reply) => resolve(reply));
    ipcRenderer.send("request-url", "req-1", request);
  });
}

describe("a requestUrl call through IPC", () => {
  it("sends its contentType as a Content-Type header", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    await requestUrl({
      url: "https://api.example.test/annotations",
      method: "POST",
      contentType: "application/json",
      body: "{}",
    });

    expect(proxied[0].headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("the request-url log line", () => {
  it("names the channel without the request's headers or body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await requestUrl({
      url: "https://api.example.test/login",
      method: "POST",
      headers: { Authorization: "Bearer SECRET" },
      body: '{"password":"SECRET"}',
    });

    expect(log).toHaveBeenCalledWith("[shim:ipcRenderer] send:", "request-url");
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
  });
});

describe("vault switcher catalog", () => {
  it("uses the server list instead of a stale bootstrap list", async () => {
    const { vaultService } = await import("@ignis/services");
    window.__vaultList = [{ id: "deleted" }, { id: "existing" }];
    vi.spyOn(vaultService, "listVaultsSync").mockReturnValue([{ id: "existing" }]);
    expect(Object.keys(ipcRenderer.sendSync("vault-list"))).toEqual(["existing"]);
  });

  it("does not offer cached vaults when refreshing fails", async () => {
    const { vaultService } = await import("@ignis/services");
    window.__vaultList = [{ id: "deleted" }];
    vi.spyOn(vaultService, "listVaultsSync").mockImplementation(() => { throw new Error("offline"); });
    expect(ipcRenderer.sendSync("vault-list")).toEqual({});
  });
});

it("does not start Obsidian with a shared default browser identity", () => {
  expect(() => ipcRenderer.sendSync("vault")).toThrow("Authenticated vault identity required");
  window.__vaultConfig = { id: "ignis-v1:account:vault", path: "/" };
  expect(ipcRenderer.sendSync("vault")).toEqual(window.__vaultConfig);
  window.__ignisAuth = { blocked: true };
  expect(() => ipcRenderer.sendSync("vault")).toThrow("Authenticated vault identity required");
});

describe("trusted community plugin policy",()=>{
 it.each(["admin","user"])("allows community plugins for %s without granting server integrations",role=>{
  window.__ignisAuth={role};
  const policy=ipcRenderer.sendSync("policy");
  expect(policy.plugins).toBe(true);expect(policy.themes).toBe(true);expect(policy.snippets).toBe(true);
  expect(policy.sync).toBe(role==="admin");expect(policy.publish).toBe(role==="admin");
 });
 it("does not enable plugins without an authenticated role",()=>{
  expect(ipcRenderer.sendSync("policy").plugins).toBe(false);
 });
});
