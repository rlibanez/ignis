import { normalize } from "../util/path.js";

const files = new Set([
  ".obsidian/app.json", ".obsidian/appearance.json",
  ".obsidian/core-plugins.json", ".obsidian/community-plugins.json",
]);
const fail = code => { throw Object.assign(new Error("Private configuration unavailable"), {code}); };

// Optional read/write adapter, not activated by the runtime yet. No disk fallback.
export function createPrivateFiles(configuration) {
  function owns(path) {
    const parts = normalize(path).toLowerCase().split("/");
    return parts.includes(".obsidian");
  }
  function select(original,resolved) {
    if (!owns(original) && !owns(resolved)) return null;
    const path = normalize(original);
    if (path !== normalize(resolved) || !files.has(path)) fail("UNSUPPORTED_CONFIGURATION");
    return path;
  }
  function encoding(value) {
    const name = typeof value === "object" ? value?.encoding : value;
    if (name && !["utf8", "utf-8"].includes(name)) fail("INVALID_CONFIGURATION_ENCODING");
    return name;
  }
  function decode(data, format) {
    encoding(format);
    if (typeof data === "string") return data;
    if (!(data instanceof Uint8Array)) fail("INVALID_CONFIGURATION");
    try { return new TextDecoder("utf-8",{fatal:true}).decode(data); }
    catch { return fail("INVALID_CONFIGURATION"); }
  }
  function encode(text,format) {
    return encoding(format) ? text : new TextEncoder().encode(text);
  }
  return Object.freeze({
    select,
    async read(path,format) {
      encoding(format);
      return encode(await configuration.read(path),format);
    },
    readSync(path,format) {
      encoding(format);
      return encode(configuration.readSync(path),format);
    },
    async write(path,data,format) { await configuration.write(path,decode(data,format)); },
    writeSync(path,data,format) { configuration.writeSync(path,decode(data,format)); },
  });
}
