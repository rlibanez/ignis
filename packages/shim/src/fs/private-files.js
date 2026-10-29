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
  function select(original,resolved, directory = false) {
    if (!owns(original) && !owns(resolved)) return null;
    const path = normalize(original);
    if (path !== normalize(resolved) || !(files.has(path) || (directory && path === ".obsidian"))) fail("UNSUPPORTED_CONFIGURATION");
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
  function metadata(path,result) {
    if (typeof result?.content !== "string" || typeof result.writable !== "boolean") fail("INVALID_CONFIGURATION");
    const directory = path === ".obsidian";
    return {
      size: directory ? 0 : new TextEncoder().encode(result.content).length,
      mtimeMs:0,ctimeMs:0,atimeMs:0,birthtimeMs:0,
      mtime:new Date(0),ctime:new Date(0),atime:new Date(0),birthtime:new Date(0),
      isFile:()=>!directory,isDirectory:()=>directory,isSymbolicLink:()=>false,
      isBlockDevice:()=>false,isCharacterDevice:()=>false,isFIFO:()=>false,isSocket:()=>false,
    };
  }
  const probe = path => path === ".obsidian" ? ".obsidian/app.json" : path;
  function checkAccess(path,result,mode) {
    if (!Number.isInteger(mode) || mode < 0 || (mode & ~7)) fail("EINVAL");
    if ((mode & 1) || ((mode & 2) && (path === ".obsidian" || !result.writable))) fail("EACCES");
  }
  return Object.freeze({
    select,
    assertOrdinary(original,resolved) {
      const root = path => ["", "."].includes(normalize(path));
      if (owns(original) || owns(resolved) || root(original) || root(resolved))
        fail("UNSUPPORTED_CONFIGURATION_OPERATION");
    },
    async stat(path) { return metadata(path,await configuration.inspect(probe(path))); },
    statSync(path) { return metadata(path,configuration.inspectSync(probe(path))); },
    async access(path,mode=0) { checkAccess(path,await configuration.inspect(probe(path)),mode); },
    accessSync(path,mode=0) { checkAccess(path,configuration.inspectSync(probe(path)),mode); },
    async readdir(path) {
      await configuration.inspect(probe(path));
      if (path !== ".obsidian") fail("ENOTDIR");
      return [...files].map(file=>file.slice(10));
    },
    readdirSync(path) {
      configuration.inspectSync(probe(path));
      if (path !== ".obsidian") fail("ENOTDIR");
      return [...files].map(file=>file.slice(10));
    },
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
