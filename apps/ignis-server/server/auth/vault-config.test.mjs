import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { projectPreferences } = require("./vault-config");
it("projects only reviewed editor values without coercion or private paths", () => {
  const input = { readableLineLength: true, spellcheck: "true", tabSize: 4, defaultViewMode: "preview", newLinkFormat: "relative", attachmentFolderPath: "Private", newFileFolderPath: "Secret", token: "secret", communityPlugins: ["arbitrary-code"] };
  expect(projectPreferences(".obsidian/app.json", input)).toEqual({ readableLineLength: true, tabSize: 4, defaultViewMode: "preview", newLinkFormat: "relative" });
  expect(input.token).toBe("secret");
});
it("allows bounded appearance values while preventing injected CSS and themes", () => {
  expect(projectPreferences(".obsidian/appearance.json", { baseFontSize: 18, accentColor: "#aabbcc", cssTheme: "untrusted", enabledCssSnippets: ["evil"], textFontFamily: "url(https://evil.invalid)" }))
    .toEqual({ baseFontSize: 18, accentColor: "#aabbcc", cssTheme: "", enabledCssSnippets: [] });
  expect(projectPreferences(".obsidian/appearance.json", { baseFontSize: 10000, accentColor: "red; background:url(x)" }))
    .toEqual({ cssTheme: "", enabledCssSnippets: [] });
});
it("does not inherit settings from object prototypes or accept unknown configuration", () => {
  const input = Object.create({ spellcheck: true, tabSize: 4, defaultViewMode: "preview" });
  expect(projectPreferences(".obsidian/app.json", input)).toEqual({});
  expect(() => projectPreferences(".obsidian/plugins/x/data.json", {})).toThrow();
  expect(projectPreferences(".obsidian/app.json", { tabSize: 0, defaultViewMode: "script" })).toEqual({});
});
