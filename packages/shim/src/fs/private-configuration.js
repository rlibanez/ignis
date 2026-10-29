// Explicit configuration transport. The FS overlay is not enabled yet.
// Lifetime is one authenticated session and one stable vault UUID.
export function createPrivateConfiguration({ vault, sessionId, currentContext, request = fetch }) {
  const states = new Map();
  function context() {
    const current = currentContext();
    if (!sessionId || !vault || current.sessionId !== sessionId || current.vault !== vault)
      throw Object.assign(new Error("Session or vault changed"), {code:"AUTH_CONTEXT_CHANGED"});
  }
  async function exchange(method, path, fields = {}) {
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
    // The installed auth fetch wrapper adds CSRF and handles session loss.
    const response = await request(url.toString(),options);
    context();
    const result = await response.json();
    context();
    if (!response.ok) throw Object.assign(new Error(result.error || "Configuration unavailable"), {code:result.code || "CONFIGURATION_UNAVAILABLE"});
    return result;
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
      if (!Number.isSafeInteger(result.revision) || result.revision < 0 || typeof result.content !== "string" || typeof result.writable !== "boolean")
        throw new Error("Invalid configuration response");
      Object.assign(value,{revision:result.revision,writable:result.writable,blocked:false});
      return result.content;
    } finally { value.busy = false; }
  }
  async function write(path, content) {
    context();
    const value = state(path);
    if (value.revision === null || value.blocked || !value.writable)
      throw Object.assign(new Error("Read configuration before saving"), {code:"CONFIGURATION_READ_REQUIRED"});
    value.busy = true;
    try {
      const result = await exchange("POST",path,{content,expectedRevision:value.revision});
      if (result.revision !== value.revision + 1) throw new Error("Invalid configuration response");
      value.revision = result.revision;
      return result;
    } catch (error) {
      // A lost response may mean the write succeeded. Never retry blindly.
      value.blocked = true;
      throw error;
    } finally { value.busy = false; }
  }
  return Object.freeze({read,write});
}
