import { it, expect } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(
  new URL("./web/client.js", import.meta.url),
  "utf8",
);
async function fixture({ storageFails = false } = {}) {
  let userId = "admin-id";
  let catalog = [{ id: "Notes", uuid: "original" }];
  const elements = [];
  let download;
  class TestURL extends URL {
    static createObjectURL(blob) { download = blob; return "blob:test"; }
    static revokeObjectURL() {}
  }
  const calls = [],
    events = [];
  let status = 200,
    current = "session-one";
  class XHR {
    constructor() {
      this.headers = {};
      this.listeners = {};
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    addEventListener(name, cb) {
      this.listeners[name] = cb;
    }
    send() {
      this.status = status;
      this.responseText = JSON.stringify({ csrfToken: "csrf-value" });
      calls.push(this);
      this.listeners.loadend?.();
    }
    abort() {
      this.aborted = true;
    }
  }
  const element = () => { const el = {
    style: {},
    append() {},
    replaceChildren() {},
    click() {},
  }; elements.push(el); return el; };
  const document = { body: element(), createElement: element };
  const window = {
    document,
    XMLHttpRequest: XHR,
    addEventListener() {},
    dispatchEvent: (e) => events.push(e.type),
    fetch: async (input, init = {}) => {
      calls.push({ input, init });
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/vault/list")) return Response.json(catalog, { status });
      if (url.endsWith("/session"))
        return Response.json({ user: { id: userId, role: "admin" }, sessionId: current });
      if (url.endsWith("/csrf"))
        return Response.json({ csrfToken: "csrf-value" });
      return Response.json({}, { status });
    },
    alert() {},
  };
  const context = {
    window,
    document,
    location: {
      origin: "https://ignis.test",
      href: "https://ignis.test/",
      replace() { events.push("redirect"); },
    },
    URL: TestURL,
    Request,
    Headers,
    Response,
    AbortController,
    Event,
    Blob,
    setTimeout,
    setInterval() {},
    localStorage: { clear() { events.push("storage-clear"); if (storageFails) throw new Error("Storage unavailable"); expect(window.__ignisAuth.blocked).toBe(false); } },
    sessionStorage: { clear() {} },
    Date,
  };
  vm.runInNewContext(source, context);
  await window.__ignisAuth.ready;
  calls.length = 0;
  return {
    window,
    user: value => { userId = value; },
    elements,
    catalog: value => { catalog = value; },
    download: () => download,
    calls,
    events,
    status: (value) => {
      status = value;
    },
    identity: (value) => {
      current = value;
    },
  };
}
it("adds CSRF and session context to local API mutations, including Request objects", async () => {
  const f = await fixture();
  await f.window.fetch(
    new Request("https://ignis.test/api/fs/writeFile", {
      method: "POST",
      body: "hello",
    }),
  );
  expect(f.calls[0].init.headers.get("X-Ignis-Csrf")).toBe("csrf-value");
  expect(f.calls[0].init.headers.get("X-Ignis-Context")).toBe("session-one");
});
it("does not attach private headers to external URLs or local static resources", async () => {
  const f = await fixture();
  for (const url of ["https://other.test/api/fs/writeFile", "/app.js"])
    await f.window.fetch(url, { method: "POST" });
  expect(f.calls.every((call) => !call.init.headers)).toBe(true);
});
it("covers synchronous XHR writes and DELETE requests", async () => {
  const f = await fixture();
  const xhr = new f.window.XMLHttpRequest();
  xhr.open("DELETE", "/api/fs/unlink", false);
  xhr.send();
  expect(xhr.headers["X-Ignis-Csrf"]).toBe("csrf-value");
  expect(xhr.headers["X-Ignis-Context"]).toBe("session-one");
});
it("locks and blocks later requests after a 401 without replaying a mutation", async () => {
  const f = await fixture();
  f.status(401);
  await expect(
    f.window.fetch("/api/fs/writeFile", { method: "POST" }),
  ).rejects.toThrow("locked");
  expect(f.events).toContain("ignis:auth-lost");
  expect(f.window.__ignisAuth.blocked).toBe(true);
  const count = f.calls.length;
  await expect(f.window.fetch("/api/vault/list")).rejects.toThrow("locked");
  expect(f.calls).toHaveLength(count);
});
it("locks an old tab when a different session replaces its cookie", async () => {
  const f = await fixture();
  f.identity("session-two");
  await f.window.__ignisAuth.check();
  expect(f.window.__ignisAuth.blocked).toBe(true);
  const xhr = new f.window.XMLHttpRequest();
  xhr.open("POST", "/api/fs/writeFile", false);
  expect(() => xhr.send()).toThrow("locked");
});

it("locks a removed vault and exports queued writes plus unsaved editor text", async () => {
  const f = await fixture();
  f.window.__currentVaultId = "Notes";
  f.window.__ignis = { writes: { snapshotPending: () => [{ path: "queued.md", data: "queued" }] } };
  f.window.app = { workspace: { iterateAllLeaves: fn => fn({ view: { file: { path: "edit.md" }, editor: { getValue: () => "unsaved text" } } }) } };
  f.catalog([]);
  await f.window.__ignisAuth.check();
  expect(f.window.__ignisAuth.blocked).toBe(true);
  expect(f.events).toContain("ignis:auth-lost");
  expect(f.elements.some(el => el.textContent === "Vault unavailable")).toBe(true);
  expect(f.elements.find(el => el.textContent === "Open Vault Manager").href).toBe("/?manager=1");
  f.elements.find(el => el.textContent === "Download unconfirmed writes").onclick();
  expect(JSON.parse(await f.download().text()).map(e => e.data)).toEqual(["queued", "unsaved text"]);
  await expect(f.window.fetch("/api/fs/writeFile", { method: "POST" })).rejects.toThrow("locked");
});
it("locks when a different vault reuses the same directory", async () => {
  const f = await fixture();
  f.window.__currentVaultId = "Notes";
  f.catalog([{ id: "Notes", uuid: "replacement" }]);
  await f.window.__ignisAuth.check();
  expect(f.window.__ignisAuth.blocked).toBe(true);
});
it("does not mistake a catalog outage or another vault deletion for losing the open vault", async () => {
  const f = await fixture();
  f.window.__currentVaultId = "Notes";
  f.status(503);
  await f.window.__ignisAuth.check();
  expect(f.window.__ignisAuth.blocked).toBe(false);
  f.status(200);
  await f.window.__ignisAuth.check();
  expect(f.window.__ignisAuth.blocked).toBe(false);
});
it("still blocks requests when an editor cannot be exported", async () => {
  const f = await fixture();
  f.window.app = { workspace: { iterateAllLeaves() { throw new Error("broken editor"); } } };
  f.window.__ignisAuth.vaultUnavailable();
  expect(f.window.__ignisAuth.blocked).toBe(true);
  expect(f.events).toContain("ignis:auth-lost");
});

it("opens the standalone manager without booting the removed vault or Obsidian", async () => {
  const html = fs.readFileSync(new URL("../assets/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>\s*(\(async function[\s\S]*?)<\/script>/)[1];
  const loaded = [];
  let opened = false;
  let splashRemoved = false;
  await vm.runInNewContext(script, {
    window: { __ignisAuth: { ready: Promise.resolve() }, IgnisUI: { showVaultManager() { opened = true; } } },
    location: { search: "?manager=1" },
    URLSearchParams,
    document: {
      createElement: () => ({}),
      head: { appendChild(script) { loaded.push(script.src); script.onload(); } },
      getElementById: () => ({ remove() { splashRemoved = true; } }),
    },
  });
  expect(loaded).toEqual(["__IGNIS_UI_SRC__"]);
  expect(opened).toBe(true);
  expect(splashRemoved).toBe(true);
});

it("pins the account identity and hides it when the session is locked", async () => {
  const f = await fixture();
  expect(f.window.__ignisAuth.userId).toBe("admin-id");
  f.user("different-account");
  await f.window.__ignisAuth.check();
  expect(f.window.__ignisAuth.blocked).toBe(true);
  expect(f.window.__ignisAuth.userId).toBeNull();
});

it("shows the manager for empty installations and unavailable vaults for either role", async () => {
  const html = fs.readFileSync(new URL("../assets/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>\s*(\(async function[\s\S]*?)<\/script>/)[1];
  for (const [role, search] of [["admin", ""], ["admin", "?vault=removed"], ["user", ""], ["user", "?vault=foreign"]]) {
    const loaded = [];
    let opened = false;
    await vm.runInNewContext(script, {
      window: { __ignisAuth: { role, ready: Promise.resolve() }, IgnisUI: { showVaultManager() { opened = true; } } },
      location: { search }, URLSearchParams,
      fetch: async () => ({ status: 404 }),
      document: { createElement: () => ({}), head: { appendChild(script) { loaded.push(script.src); script.onload(); } }, getElementById: () => ({ remove() {} }) },
    });
    expect(loaded).toEqual(["__IGNIS_UI_SRC__"]);
    expect(opened).toBe(true);
  }
});

it("leaves a revoked session even when clearing browser storage fails", async () => {
  for (const storageFails of [false, true]) {
    const f = await fixture({ storageFails });
    await f.window.__ignisAuth.logout();
    expect(f.events.indexOf("storage-clear")).toBeLessThan(f.events.indexOf("ignis:auth-lost"));
    expect(f.events).toContain("redirect");
    expect(f.window.__ignisAuth.blocked).toBe(true);
  }
});

it("preserves legacy administrator vaults and does not treat server failures as an empty installation", async () => {
  const html = fs.readFileSync(new URL("../assets/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>\s*(\(async function[\s\S]*?)<\/script>/)[1];
  for (const status of [200, 403, 500]) {
    const loaded = [];
    let target;
    let locked = false;
    await vm.runInNewContext(script, {
      window: { __ignisAuth: { role: "admin", ready: Promise.resolve(), lock() { locked = true; } } },
      location: { search: "", pathname: "/" }, URLSearchParams,
      history: { replaceState(_state, _title, url) { target = url; } },
      fetch: async () => ({ status, ok: status === 200, json: async () => ({ id: "Legacy" }) }),
      document: { createElement: () => ({}), head: { appendChild(script) {
        loaded.push(script.src);
        // Stop at the loader: this test validates selection, not Obsidian itself.
        script.onerror(new Error("End of fixture"));
      } } },
    });
    expect(loaded).toEqual(status === 200 ? ["__SHIM_LOADER_SRC__"] : []);
    expect(target).toBe(status === 200 ? "/?vault=Legacy" : undefined);
    expect(locked).toBe(true);
  }
});
