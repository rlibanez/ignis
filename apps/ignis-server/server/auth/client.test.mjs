import { it, expect } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(
  new URL("./web/client.js", import.meta.url),
  "utf8",
);
async function fixture() {
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
  const element = () => ({
    style: {},
    append() {},
    replaceChildren() {},
    click() {},
  });
  const document = { body: element(), createElement: element };
  const window = {
    document,
    XMLHttpRequest: XHR,
    addEventListener() {},
    dispatchEvent: (e) => events.push(e.type),
    fetch: async (input, init = {}) => {
      calls.push({ input, init });
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/session"))
        return Response.json({ user: { role: "admin" }, sessionId: current });
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
      replace() {},
    },
    URL,
    Request,
    Headers,
    Response,
    AbortController,
    Event,
    Blob,
    setTimeout,
    setInterval() {},
    localStorage: { clear() {} },
    sessionStorage: { clear() {} },
    Date,
  };
  vm.runInNewContext(source, context);
  await window.__ignisAuth.ready;
  calls.length = 0;
  return {
    window,
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
