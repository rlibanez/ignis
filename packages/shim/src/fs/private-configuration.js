// Explicit configuration transport. The FS overlay is not enabled yet.
// Lifetime is one authenticated session and one stable vault UUID.
export function createPrivateConfiguration({ vault, sessionId, currentContext, request = fetch, createXHR = () => new XMLHttpRequest() }) {
  const states = new Map();
  function context() {
    const current = currentContext();
    if (!sessionId || !vault || !current || current.sessionId !== sessionId || current.vault !== vault)
      throw Object.assign(new Error("Session or vault changed"), {code:"AUTH_CONTEXT_CHANGED"});
  }
  function prepare(method, path, fields) {
    context();
    const url = new URL("/api/vault-config", window.location.origin);
    const options = {method, headers:{"x-ignis-context":sessionId}, cache:"no-store"};
    if (method === "GET") {
      url.searchParams.set("vault",vault);
      url.searchParams.set("path",path);
    } else {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify({vault,path,...fields});
    }
    return {url:url.toString(),options};
  }
  function responseResult(ok, result) {
    context();
    if (!ok) throw Object.assign(new Error(result?.error || "Configuration unavailable"), {code:result?.code || "CONFIGURATION_UNAVAILABLE"});
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid configuration response");
    return result;
  }
  async function exchange(method, path, fields = {}) {
    const {url,options} = prepare(method,path,fields);
    // Installed auth fetch/XHR wrappers add CSRF and handle session loss.
    const response = await request(url,options);
    context();
    return responseResult(response.ok,await response.json());
  }
  function exchangeSync(method, path, fields = {}) {
    const {url,options} = prepare(method,path,fields);
    const xhr = createXHR();
    xhr.open(method,url,false);
    for (const [name,value] of Object.entries(options.headers)) xhr.setRequestHeader(name,value);
    xhr.send(options.body ?? null);
    context();
    // status 0 (network failure/aborted request) must never acknowledge a write.
    return responseResult(xhr.status >= 200 && xhr.status < 300,JSON.parse(xhr.responseText));
  }
  function state(path) {
    if (!states.has(path)) states.set(path,{busy:false,revision:null,writable:false,blocked:false});
    const value = states.get(path);
    if (value.busy) throw Object.assign(new Error("Configuration operation in progress"), {code:"CONFIGURATION_BUSY"});
    return value;
  }
  async function read(path) {
    const value = state(path);
    value.busy = true;
    try {
      const result = await exchange("GET",path);
      return acceptRead(value,result);
    } catch (error) {
      value.blocked = true;
      throw error;
    } finally { value.busy = false; }
  }
  async function write(path, content) {
    context();
    const value = state(path);
    requireWritable(value);
    value.busy = true;
    try {
      const result = await exchange("POST",path,{content,expectedRevision:value.revision});
      return acceptWrite(value,result);
    } catch (error) {
      // A lost response may mean the write succeeded. Never retry blindly.
      value.blocked = true;
      throw error;
    } finally { value.busy = false; }
  }
  function acceptRead(value,result) {
    if (!Number.isSafeInteger(result.revision) || result.revision < 0 || typeof result.content !== "string" || typeof result.writable !== "boolean")
      throw new Error("Invalid configuration response");
    Object.assign(value,{revision:result.revision,writable:result.writable,blocked:false});
    return result.content;
  }
  function requireWritable(value) {
    if (value.revision === null || value.blocked || !value.writable || value.revision >= Number.MAX_SAFE_INTEGER)
      throw Object.assign(new Error("Read configuration before saving"), {code:"CONFIGURATION_READ_REQUIRED"});
  }
  function acceptWrite(value,result) {
    if (!Number.isSafeInteger(result.revision) || result.revision !== value.revision + 1) throw new Error("Invalid configuration response");
    value.revision = result.revision;
    return result;
  }
  function readSync(path) {
    const value = state(path);
    value.busy = true;
    try { return acceptRead(value,exchangeSync("GET",path)); }
    catch (error) { value.blocked = true; throw error; }
    finally { value.busy = false; }
  }
  function writeSync(path,content) {
    context();
    const value = state(path);
    requireWritable(value);
    value.busy = true;
    try { return acceptWrite(value,exchangeSync("POST",path,{content,expectedRevision:value.revision})); }
    catch (error) { value.blocked = true; throw error; }
    finally { value.busy = false; }
  }
  // Metadata must not advance the revision that authorizes a later save.
  async function inspect(path) {
    const value = state(path);
    value.busy = true;
    try { return await exchange("GET",path); }
    finally { value.busy = false; }
  }
  function inspectSync(path) {
    const value = state(path);
    value.busy = true;
    try { return exchangeSync("GET",path); }
    finally { value.busy = false; }
  }
  return Object.freeze({read,write,readSync,writeSync,inspect,inspectSync});
}
