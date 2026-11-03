import { expect, it, vi, afterEach } from "vitest";
const modalHarness = vi.hoisted(() => ({current: null, element: null}));
vi.mock("../../../shim/src/native-tooltip.js", () => ({nativeTooltip: vi.fn()}));
vi.mock("obsidian", () => ({
  Modal: class {
    constructor() { this.contentEl = modalHarness.element(); this.modalEl = modalHarness.element(); }
    setTitle() {}
    open() { modalHarness.current = this; this.onOpen(); }
    close() { this.onClose(); }
  },
  Notice: class {}, Setting: class {}, SettingTab: class {}, setIcon: vi.fn(),
}));
import { settingDefinitions } from "./account-tab.js";
afterEach(() => vi.unstubAllGlobals());

it.each(["admin", "user"])("renders separate native rows and role-dependent actions for %s", async role => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ok:true,json:async()=>({sessionId:"s",user:{login:"alice",role},hasLocalPassword:true,oidcAvailable:true,oidcButtonText:"Authentik"})})));
  const tab = {update:vi.fn(),app:{}};
  settingDefinitions(tab);
  await vi.waitFor(() => expect(tab.update).toHaveBeenCalledOnce());
  const groups = settingDefinitions(tab);
  expect(groups).toHaveLength(1);
  expect(groups[0].heading).toBeUndefined();
  expect(groups[0].items.map(i=>i.name)).toEqual(["Username", "Email", "Change password", "OpenID Connect", ...(role === "admin" ? ["Manage users"] : []), "Shared resources"]);
  const button = {setButtonText:vi.fn().mockReturnThis(),onClick:vi.fn().mockReturnThis()};
  const row = {setDesc:vi.fn().mockReturnThis(),addButton:fn=>fn(button)};
  groups[0].items.find(item=>item.name==="Shared resources").render(row);
  expect(row.setDesc).toHaveBeenCalledWith("Manage the files and folders you share and those shared with you.");
  expect(button.setButtonText).toHaveBeenCalledWith("Open");
});
it("shows an error row when the session cannot be loaded", async () => {
  vi.stubGlobal("fetch", vi.fn(async()=>({ok:false})));
  const tab={update:vi.fn()};settingDefinitions(tab);
  await vi.waitFor(()=>expect(tab.update).toHaveBeenCalledOnce());
  const row={settingEl:{addClass:vi.fn()},setDesc:vi.fn()};
  settingDefinitions(tab)[0].items[0].render(row);
  expect(row.setDesc).toHaveBeenCalledWith("Request failed");
});

it("links directly with CSRF and the current session context", async () => {
  const assign=vi.fn();vi.stubGlobal("window", {location:{assign}});
  vi.stubGlobal("fetch",vi.fn(async url=>({ok:true,json:async()=> url === "/api/auth/session" ? {sessionId:"session",user:{login:"alice",role:"user"},hasLocalPassword:true} : url === "/api/auth/status" ? {oidcAvailable:true,oidcButtonText:"Authentik"} : url === "/api/auth/csrf" ? {csrfToken:"csrf"} : {authorizationUrl:"https://id.example/authorize"}})));
  const tab={update:vi.fn(),app:{}};settingDefinitions(tab);
  await vi.waitFor(()=>expect(tab.update).toHaveBeenCalledOnce());
  let click;
  const button={setButtonText:vi.fn().mockReturnThis(),setDisabled:vi.fn(),onClick:fn=>{click=fn;}};
  settingDefinitions(tab)[0].items.find(item=>item.name==="OpenID Connect").render({setDesc(){return this;},addButton:fn=>fn(button)});
  expect(button.setButtonText).toHaveBeenCalledWith("Link Authentik account");
  await click();
  expect(fetch).toHaveBeenCalledWith("/api/auth/oidc/link",expect.objectContaining({method:"POST",headers:expect.objectContaining({"X-Ignis-Csrf":"csrf","X-Ignis-Context":"session"})}));
  expect(assign).toHaveBeenCalledWith("https://id.example/authorize");
});

it.each([
  [403, {code:"REAUTH_REQUIRED"}, "/login?reauth=link"],
  [200, {authorizationUrl:"javascript:alert(1)"}, null],
  [503, {}, null],
])("handles provider response %s safely", async (status, body, destination) => {
  const assign=vi.fn();vi.stubGlobal("window",{location:{assign}});
  vi.stubGlobal("fetch",vi.fn(async url=>({ok:url!=="/api/auth/oidc/link"||status===200,status,json:async()=>url==="/api/auth/session"?{sessionId:"s",user:{login:"alice",role:"user"},hasLocalPassword:true}:url==="/api/auth/status"?{oidcAvailable:true}:url==="/api/auth/csrf"?{csrfToken:"csrf"}:body})));
  const tab={update:vi.fn(),app:{}};settingDefinitions(tab);
  await vi.waitFor(()=>expect(tab.update).toHaveBeenCalledOnce());
  let click;const button={setButtonText(){return this;},setDisabled:vi.fn(),onClick:fn=>{click=fn;}};
  settingDefinitions(tab)[0].items.find(item=>item.name==="OpenID Connect").render({setDesc(){return this;},addButton:fn=>fn(button)});
  await click();
  if(destination) expect(assign).toHaveBeenCalledWith(destination);else expect(assign).not.toHaveBeenCalled();
  expect(button.setDisabled).toHaveBeenLastCalledWith(false);
});

it.each([true, false])("offers self-unlink to normal users, requiring a local password (%s)", async hasLocalPassword => {
  vi.stubGlobal("fetch", vi.fn(async url => ({ok:true,json:async()=> url === "/api/auth/session"
    ? {sessionId:"s",user:{login:"alice",role:"user"},oidcLinked:true,hasLocalPassword}
    : {oidcAvailable:true,oidcButtonText:"Authentik"}})));
  const tab={update:vi.fn(),app:{}};settingDefinitions(tab);
  await vi.waitFor(()=>expect(tab.update).toHaveBeenCalledOnce());
  const button={setButtonText:vi.fn().mockReturnThis(),setDisabled:vi.fn().mockReturnThis(),onClick:vi.fn().mockReturnThis()};
  settingDefinitions(tab)[0].items.find(item=>item.name==="OpenID Connect").render({setDesc(){return this;},addButton:fn=>fn(button)});
  expect(button.setButtonText).toHaveBeenCalledWith("Unlink Authentik account");
  expect(button.setDisabled).toHaveBeenCalledWith(!hasLocalPassword);
});


it("preserves the new password after an incorrect current password and clears it on close", async () => {
  function element(tag = "div", options = {}) {
    return {
      tag, ...options, value: "", children: [], handlers: {},
      addClass() {}, setAttribute() {}, focus: vi.fn(),
      createEl(name, attrs) { const child = element(name, attrs); this.children.push(child); return child; },
      createSpan(attrs) { return this.createEl("span", attrs); },
      createDiv(attrs) { return this.createEl("div", attrs); },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      querySelectorAll(name) { return this.children.flatMap(child => [...(child.tag === name ? [child] : []), ...child.querySelectorAll(name)]); },
      empty() { this.children = []; },
    };
  }
  modalHarness.element = element;
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", vi.fn(async url => ({
    ok: url !== "/api/auth/password",
    json: async () => url === "/api/auth/session"
      ? {sessionId: "s", user: {login: "alice", role: "user"}, hasLocalPassword: true, passwordPolicy: {minLength: 8, minSpecialChars: 0}}
      : url === "/api/auth/csrf" ? {csrfToken: "csrf"} : {code: "INVALID_PASSWORD"},
  })));
  const tab = {update: vi.fn(), app: {}};
  settingDefinitions(tab);
  await vi.waitFor(() => expect(tab.update).toHaveBeenCalledOnce());
  let click;
  settingDefinitions(tab)[0].items.find(item => item.name === "Change password").render({
    setDesc() { return this; },
    addButton(fn) { fn({setButtonText() { return this; }, onClick(handler) { click = handler; }}); },
  });
  click();
  const modal = modalHarness.current;
  const [current, password, confirmation] = modal.contentEl.querySelectorAll("input");
  expect(current.focus).toHaveBeenCalledOnce();
  expect(current.autofocus).toBe(true);
  current.value = "incorrect";
  password.value = confirmation.value = "new password";
  await modal.contentEl.querySelectorAll("form")[0].handlers.submit({preventDefault() {}});
  expect(modal.contentEl.querySelectorAll("p")[0].textContent).toBe("The current password is incorrect.");
  expect(current.value).toBe("");
  expect(password.value).toBe("new password");
  expect(confirmation.value).toBe("new password");
  modal.close();
  expect(password.value).toBe("");
  expect(confirmation.value).toBe("");
});

it.each([true,false])('submits email safely or reports an incorrect password on its field (recent=%s)',async recentAuthentication=>{
 function element(tag='div',options={}){return {tag,...options,value:'',children:[],handlers:{},addClass(){},
  createEl(name,attrs){const child=element(name,attrs);this.children.push(child);return child;},createDiv(attrs){return this.createEl('div',attrs);},createSpan(attrs){return this.createEl('span',attrs);},setAttribute(){},focus:vi.fn(),setCustomValidity:vi.fn(),reportValidity:vi.fn(),
  addEventListener(name,fn){this.handlers[name]=fn;},querySelectorAll(name){return this.children.flatMap(child=>[...(child.tag===name?[child]:[]),...child.querySelectorAll(name)]);},empty(){this.children=[];}};}
 modalHarness.element=element;vi.stubGlobal('window',new EventTarget());
 vi.stubGlobal('fetch',vi.fn(async url=>({ok:url!=='/api/auth/reauth',status:url==='/api/auth/reauth'?400:200,json:async()=>url==='/api/auth/session'
  ?{sessionId:'s',user:{login:'alice',role:'user'},hasLocalPassword:true,recentAuthentication,email:'old@example.com',emailTrust:'admin_confirmed'}
  :url==='/api/auth/csrf'?{csrfToken:'csrf'}:url==='/api/auth/email'?{email:'new@example.com',emailTrust:'unverified',signedOut:false}:{}})));
 const tab={update:vi.fn(),app:{}};settingDefinitions(tab);await vi.waitFor(()=>expect(tab.update).toHaveBeenCalledOnce());
 let click;settingDefinitions(tab)[0].items.find(item=>item.name==='Email').render({setDesc(){return this;},addButton(fn){fn({setButtonText(){return this;},onClick(fn){click=fn;}});}});
 click();const modal=modalHarness.current;
 expect(modal.contentEl.querySelectorAll('input')[0].focus).toHaveBeenCalledOnce();
 modal.contentEl.querySelectorAll('input')[0].value='new@example.com';
 await modal.contentEl.querySelectorAll('form')[0].handlers.submit({preventDefault(){}});
 if(!recentAuthentication){
  const password=modal.contentEl.querySelectorAll('input')[1];
  expect(password.setCustomValidity).toHaveBeenCalledWith('Incorrect password');
  expect(password.reportValidity).toHaveBeenCalledOnce();
  expect(modal.contentEl.querySelectorAll('p')[0].textContent).toBe('');
  expect(fetch.mock.calls.some(([url])=>url==='/api/auth/email')).toBe(false);
  password.handlers.input();expect(password.setCustomValidity).toHaveBeenLastCalledWith('');return;
 }
 const options=fetch.mock.calls.find(([url])=>url==='/api/auth/email')[1];
 expect(options.headers).toMatchObject({'X-Ignis-Csrf':'csrf','X-Ignis-Context':'s'});
 expect(JSON.parse(options.body)).toEqual({email:'new@example.com',expectedEmail:'old@example.com',expectedEmailTrust:'admin_confirmed'});
});
