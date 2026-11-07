import { it, expect, vi } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(
  new URL("./web/client.js", import.meta.url),
  "utf8",
);
async function fixture({ storageFails = false, initialSessionStatus = 200, initialOffline = false, initialUser = "admin-id", storageValues = new Map() } = {}) {
  let userId = initialUser, sessionStatus = initialSessionStatus, offline = initialOffline;
  let catalog = [{ id: "Notes", uuid: "original" }];
  const elements = [], redirects = [];
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
      if (url.endsWith("/session")) {
        if (offline) throw new TypeError("Network unavailable");
        return Response.json({ user: { id: userId, role: "admin" }, sessionId: current }, { status: sessionStatus });
      }
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
      replace(url) { events.push("redirect"); redirects.push(url); },
    },
    URL: TestURL,
    Request,
    Headers,
    Response,
    AbortController,
    Event,
    Blob,
    setTimeout,
    clearTimeout,
    setInterval() {},
    localStorage: { getItem(key) { if(storageFails)throw Error("Storage unavailable"); return storageValues.get(key) ?? null; }, setItem(key,value) { if(storageFails)throw Error("Storage unavailable"); storageValues.set(key,value); }, clear() { events.push("storage-clear"); if (storageFails) throw new Error("Storage unavailable"); expect(window.__ignisAuth.blocked).toBe(false); } },
    sessionStorage: { clear() {} },
    Date,
  };
  vm.runInNewContext(source, context);
  await window.__ignisAuth.ready;
  calls.length = 0;
  return {
    window,
    offline: value => { offline = value; },
    sessionStatus: value => { sessionStatus = value; },
    user: value => { userId = value; },
    elements,
    redirects,
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
    window: { __ignisAuth: { ready: Promise.resolve() }, IgnisUI: { openRequestedManagement() {}, showVaultManager() { opened = true; } } },
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
      window: { __ignisAuth: { role, ready: Promise.resolve() }, IgnisUI: { openRequestedManagement() {}, showVaultManager() { opened = true; } } },
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

it.each([429, 500, 502, 503])("retains a verified editor during session check HTTP %s and locks after revocation", async status => {
  const f = await fixture(); f.sessionStatus(status);
  await f.window.__ignisAuth.check(); expect(f.window.__ignisAuth.blocked).toBe(false);
  f.sessionStatus(401); await f.window.__ignisAuth.check();
  expect(f.window.__ignisAuth.blocked).toBe(true);
});
it("recovers from a session-check network outage without changing pinned identity", async () => {
  const f = await fixture(); f.offline(true);
  await f.window.__ignisAuth.check(); expect(f.window.__ignisAuth.blocked).toBe(false);
  f.offline(false); await f.window.__ignisAuth.check();
  await f.window.fetch('/api/fs/writeFile', {method:'POST'});
  expect(f.calls.at(-1).init.headers.get('X-Ignis-Context')).toBe('session-one');
  f.identity('other-session'); await f.window.__ignisAuth.check();
  expect(f.window.__ignisAuth.blocked).toBe(true);
});

it.each([401,403,400])('locks a verified editor when the session endpoint rejects access with %s',async status=>{
 const f=await fixture(); f.sessionStatus(status); await f.window.__ignisAuth.check();
 expect(f.window.__ignisAuth.blocked).toBe(true);
});
it('does not initialize an editor without an initially verified session',async()=>{
 await expect(fixture({initialSessionStatus:503})).rejects.toThrow('Session unavailable');
 await expect(fixture({initialOffline:true})).rejects.toThrow('Session check unavailable');
});

it("returns to the vault manager after safely renaming the active vault", async () => {
  const f = await fixture();
  f.window.__currentVaultUuid = "original";
  let saved = false;
  f.window.app = { workspace: { iterateAllLeaves: cb => cb({ view: {
    file: {}, save: async () => { saved = true; }, getViewData: () => "note", lastSavedData: "note",
  } }) } };
  await f.window.__ignisAuth.beginVaultRename("original");
  expect(saved).toBe(true);
  f.window.__ignisAuth.vaultUnavailable();
  expect(f.window.__ignisAuth.blocked).toBe(false);
  f.catalog([{ id: "Renamed", uuid: "original" }]);
  await f.window.__ignisAuth.finishVaultRename(true);
  expect(f.redirects).toEqual(["/?manager=1"]);
  expect(f.events).toContain("redirect");
  expect(f.window.__ignisAuth.blocked).toBe(false);
});
it("refuses rename preparation while writes remain unconfirmed", async () => {
  const f = await fixture();
  f.window.__currentVaultUuid = "original";
  f.window.__ignis = { writes: { snapshotPending: () => [{ path: "note.md", data: "draft" }] } };
  await expect(f.window.__ignisAuth.beginVaultRename("original")).rejects.toThrow("not confirmed");
});
it.each(["removed", "dirty", "session", "failed"])("does not redirect after an unsafe rename: %s", async reason => {
  const f = await fixture();
  f.window.__currentVaultUuid = "original";
  await f.window.__ignisAuth.beginVaultRename("original");
  f.window.__ignisAuth.vaultUnavailable();
  if (reason === "removed") f.catalog([{ id: "Notes", uuid: "replacement" }]);
  if (reason === "session") f.identity("another-session");
  if (reason === "dirty") f.window.app = { workspace: { iterateAllLeaves: cb => cb({ view: {
    file: { path: "note.md" }, getViewData: () => "draft", lastSavedData: "saved",
  } }) } };
  await f.window.__ignisAuth.finishVaultRename(reason !== "failed");
  expect(f.events).not.toContain("redirect");
  expect(f.window.__ignisAuth.blocked).toBe(true);
});


it("returns to the manager after intentional deletion despite an early unavailable event", async () => {
  const f = await fixture();
  f.window.__currentVaultUuid = "original";
  await f.window.__ignisAuth.beginVaultDelete("original");
  f.window.__ignisAuth.vaultUnavailable();
  expect(f.window.__ignisAuth.blocked).toBe(false);
  f.catalog([]);
  await f.window.__ignisAuth.finishVaultDelete(true);
  expect(f.redirects).toEqual(["/?manager=1"]);
});
it.each(["present", "dirty", "session", "failed"])("preserves protection during unsafe deletion: %s", async reason => {
  const f = await fixture();
  f.window.__currentVaultUuid = "original";
  await f.window.__ignisAuth.beginVaultDelete("original");
  f.window.__ignisAuth.vaultUnavailable();
  f.catalog(reason === "present" ? [{id: "Notes", uuid: "original"}] : []);
  if (reason === "session") f.identity("another-session");
  if (reason === "dirty") f.window.__ignis = { writes: { snapshotPending: () => [{path: "note.md", data: "draft"}] } };
  await f.window.__ignisAuth.finishVaultDelete(reason !== "failed");
  expect(f.redirects).toEqual([]);
  expect(f.window.__ignisAuth.blocked).toBe(true);
});

it('retains the verified account and its storage if server logout was not confirmed',async()=>{
 const f=await fixture();const start=f.events.length;f.status(503);await f.window.__ignisAuth.logout();
 expect(f.events.slice(start)).not.toContain('storage-clear');expect(f.events.slice(start)).not.toContain('redirect');
 expect(f.events.slice(start)).not.toContain('ignis:auth-lost');expect(f.window.__ignisAuth.blocked).toBe(false);
});

it('keeps an open UUID and unsaved editor data when ownership moves its unchanged name to another user namespace',async()=>{
 const f=await fixture();f.window.__currentVaultId='alice/Notes';f.window.__currentVaultUuid='original';
 const view={file:{path:'draft.md'},getViewData:()=> 'unsaved draft',lastSavedData:'saved'};f.window.app={workspace:{iterateAllLeaves:cb=>cb({view})}};
 f.catalog([{id:'bob/Notes',name:'Notes',uuid:'original',membership:'reader'}]);await f.window.__ignisAuth.check();
 expect(f.window.__ignisAuth.blocked).toBe(false);expect(f.window.__currentVaultId).toBe('bob/Notes');expect(f.window.__currentVaultUuid).toBe('original');expect(view.getViewData()).toBe('unsaved draft');expect(f.redirects).toEqual([]);
 f.catalog([{id:'bob/Notes',name:'Notes',uuid:'replacement'}]);await f.window.__ignisAuth.check();expect(f.window.__ignisAuth.blocked).toBe(true);
});
it('does not treat a different UUID under another namespace as an ownership move',async()=>{
 const f=await fixture();f.window.__currentVaultId='alice/Notes';f.window.__currentVaultUuid='original';f.catalog([{id:'bob/Notes',uuid:'other'}]);await f.window.__ignisAuth.check();expect(f.window.__ignisAuth.blocked).toBe(true);
});

it('tolerates only a bounded server-announced relocation gap and locks if the UUID does not return',async()=>{
 vi.useFakeTimers();
 try{
  const f=await fixture();f.window.__currentVaultId='alice/Notes';f.window.__currentVaultUuid='original';f.window.__ignisAuth.vaultRelocating('original');f.catalog([]);
  await f.window.__ignisAuth.check();expect(f.window.__ignisAuth.blocked).toBe(false);
  f.window.__ignisAuth.vaultUnavailable();expect(f.window.__ignisAuth.blocked).toBe(false);
  await vi.advanceTimersByTimeAsync(10001);expect(f.window.__ignisAuth.blocked).toBe(true);
 }finally{vi.useRealTimers();}
});
it('never applies relocation grace to another UUID or an unannounced disappearance',async()=>{
 const f=await fixture();f.window.__currentVaultId='alice/Notes';f.window.__currentVaultUuid='original';f.window.__ignisAuth.vaultRelocating('foreign');f.catalog([]);await f.window.__ignisAuth.check();expect(f.window.__ignisAuth.blocked).toBe(true);
});

it("remembers a stable vault across page loads and account storage installation", async () => {
  const storageValues = new Map();
  const first = await fixture({storageValues});
  first.window.__ignisAuth.rememberVault("vault-c-uuid");
  first.window.localStorage = {getItem() {throw Error("scoped facade must not be used");}, setItem() {throw Error("scoped facade must not be used");}};
  expect(first.window.__ignisAuth.rememberedVault()).toBe("vault-c-uuid");
  first.window.__ignisAuth.rememberVault("renamed-same-uuid");
  const reopened = await fixture({storageValues});
  expect(reopened.window.__ignisAuth.rememberedVault()).toBe("renamed-same-uuid");
  const other = await fixture({storageValues, initialUser:"other-account"});
  expect(other.window.__ignisAuth.rememberedVault()).toBeNull();
  other.window.__ignisAuth.rememberVault("other-vault");
  first.window.__ignisAuth.lock();
  first.window.__ignisAuth.rememberVault("blocked-write");
  expect(first.window.__ignisAuth.rememberedVault()).toBeNull();
  expect(reopened.window.__ignisAuth.rememberedVault()).toBe("renamed-same-uuid");
});
it("keeps remembering optional when browser storage is unavailable", async () => {
  const f=await fixture({storageFails:true});
  expect(()=>f.window.__ignisAuth.rememberVault("vault")).not.toThrow();
  expect(f.window.__ignisAuth.rememberedVault()).toBeNull();
});
it.each([
  ["", "saved-uuid", 200, "saved-uuid"],
  ["?vault=explicit-uuid", "saved-uuid", 200, "explicit-uuid"],
  ["", null, 200, null],
  ["", "removed-uuid", 404, "removed-uuid"],
  ["", "saved-uuid", 503, "saved-uuid"],
  ["?manager=1", "saved-uuid", 200, undefined],
])("selects remembered vault safely on startup (%s, %s, %s)",async(search,saved,status,expected)=>{
  const html=fs.readFileSync(new URL("../assets/index.html",import.meta.url),"utf8");
  const script=html.match(/<script>\s*(\(async function[\s\S]*?)<\/script>/)[1];
  const calls=[],loaded=[];let manager=false,target;
  await vm.runInNewContext(script,{
    window:{__ignisAuth:{ready:Promise.resolve(),role:"user",rememberedVault:()=>saved,lock(){}},IgnisUI:{showVaultManager(){manager=true;},openRequestedManagement(){}}},
    location:{search,pathname:"/"},URLSearchParams,
    history:{state:{ignisVirtualEntry:true},replaceState(state,_title,url){expect(state.ignisVirtualEntry).toBe(true);target=url;}},
    fetch:async url=>{calls.push(url);return {status,ok:status===200,json:async()=>({id:"owner/C",uuid:"confirmed-uuid"})};},
    document:{createElement:()=>({}),getElementById:()=>({remove(){}}),head:{appendChild(script){loaded.push(script.src);if(script.src==="__IGNIS_UI_SRC__")script.onload();else script.onerror(Error("stop before Obsidian"));}}},
  });
  expect(calls).toEqual(expected===undefined?[]:["/api/vault/info"+(expected?"?vault="+expected:"")]);
  expect(manager).toBe(status===404 || expected===undefined);
  if(status===200 && expected!==undefined)expect(target).toBe("/?vault=confirmed-uuid");
  if(status===503)expect(loaded).toEqual([]);
});
it("writes plugin trust to the same account storage before and after Obsidian starts",async()=>{
 const {scopedStorage}=await import('../../../../packages/shim/src/account-storage.js');
 const values=new Map(),f=await fixture({storageValues:values});
 const native={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
 const scoped=scopedStorage(native,'admin-id',()=>f.window.__ignisAuth.userId);
 const key='enable-plugin-ignis-v1:admin-id:vault';
 f.window.__ignisAuth.setVaultTrust('vault',true);
 expect(scoped.getItem(key)).toBe('true');
 f.window.localStorage=scoped;
 f.window.__ignisAuth.setVaultTrust('vault',false);
 expect(scoped.getItem(key)).toBe('false');
 const other=await fixture({storageValues:values,initialUser:'other'});
 other.window.__ignisAuth.setVaultTrust('vault',true);
 expect(scoped.getItem(key)).toBe('false');
 f.window.__ignisAuth.lock();f.window.__ignisAuth.setVaultTrust('vault',true);
 expect(values.get('ignis-account-v1:admin-id:'+key)).toBe('false');
});
