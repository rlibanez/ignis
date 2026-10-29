// Server-owned projection for the future non-admin Obsidian runtime. It never
// reads the vault's shared .obsidian directory. Not installed as an FS overlay yet.
const { createVaultPreferencesService } = require("./vault-preferences");
const fail = code => { throw Object.assign(new Error("Configuration unavailable"), { code }); };
const booleanFields = new Set([
  "readableLineLength", "showLineNumber", "spellcheck", "strictLineBreaks",
  "autoPairBrackets", "autoPairMarkdown", "useMarkdownLinks", "alwaysUpdateLinks",
]);
const fixed = new Map([
  [".obsidian/community-plugins.json", []],
  [".obsidian/core-plugins.json", { "file-explorer": true, "global-search": true, switcher: true, sync: false, publish: false, workspaces: false }],
]);

function projectPreferences(path, input) {
  const result = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  if (path === ".obsidian/app.json") {
    for (const key of booleanFields) if (Object.hasOwn(input, key) && typeof input[key] === "boolean") result[key] = input[key];
    if (Object.hasOwn(input, "defaultViewMode") && ["source", "preview"].includes(input.defaultViewMode)) result.defaultViewMode = input.defaultViewMode;
    if (Object.hasOwn(input, "newLinkFormat") && ["shortest", "relative", "absolute"].includes(input.newLinkFormat)) result.newLinkFormat = input.newLinkFormat;
    if (Object.hasOwn(input, "tabSize") && Number.isInteger(input.tabSize) && input.tabSize >= 1 && input.tabSize <= 8) result.tabSize = input.tabSize;
  } else if (path === ".obsidian/appearance.json") {
    if (Object.hasOwn(input, "baseFontSize") && Number.isInteger(input.baseFontSize) && input.baseFontSize >= 10 && input.baseFontSize <= 48) result.baseFontSize = input.baseFontSize;
    if (Object.hasOwn(input, "accentColor") && typeof input.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(input.accentColor)) result.accentColor = input.accentColor;
    // Shared CSS is code; private data cannot enable themes or snippets.
    result.cssTheme = "";
    result.enabledCssSnippets = [];
  } else fail("UNSUPPORTED_CONFIGURATION");
  return result;
}

function createVaultConfigService(db, vaultRoot, sessions) {
  const preferences = createVaultPreferencesService(db, vaultRoot, sessions);
  function read(token, { reference, path } = {}) {
    if (fixed.has(path)) {
      // Even constant configuration requires an authorized session/membership.
      preferences.read(token, { reference, path: ".obsidian/app.json" });
      return { content: JSON.stringify(fixed.get(path)), revision: 0, writable: false };
    }
    if (![".obsidian/app.json", ".obsidian/appearance.json"].includes(path)) fail("UNSUPPORTED_CONFIGURATION");
    const stored = preferences.read(token, { reference, path });
    let value;
    try { value = JSON.parse(stored.content); } catch { fail("INVALID_CONFIGURATION"); }
    return { content: JSON.stringify(projectPreferences(path, value)), revision: stored.revision, writable: true };
  }
  function write(token, { reference, path, content, expectedRevision } = {}) {
    if (![".obsidian/app.json", ".obsidian/appearance.json"].includes(path)) fail("UNSUPPORTED_CONFIGURATION");
    if (typeof content !== "string" || Buffer.byteLength(content) > 1048576) fail("INVALID_CONFIGURATION");
    let value;
    try { value = JSON.parse(content); } catch { fail("INVALID_CONFIGURATION"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_CONFIGURATION");
    // Store only the same projection we will return. Revision conflicts remain
    // the persistence service's responsibility; no retry or silent overwrite.
    const projected = JSON.stringify(projectPreferences(path, value));
    return preferences.write(token, { reference, path, content: projected, expectedRevision });
  }
  function snapshot(token, reference) {
    // Fresh objects on every request; never reuse another caller's projection.
    return Object.fromEntries([
      ".obsidian/app.json", ".obsidian/appearance.json", ...fixed.keys(),
    ].map(path => [path, read(token, { reference, path })]));
  }
  return Object.freeze({ read, write, snapshot });
}
module.exports = { projectPreferences, createVaultConfigService };
