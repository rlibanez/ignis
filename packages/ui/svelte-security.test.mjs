import { it, expect } from "vitest";
import { parse, compile } from "svelte/compiler";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const options = require("./compiler-options");
const root = fileURLToPath(new URL("./src", import.meta.url));

// Conservative guard for GHSA-rcqx-6q8c-2c42: a form receiving spread attributes
// needs a new review, even if a developer believes its descendants are trusted.
function riskyForms(source) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (
      (node.name === "form" || node.name === "svelte:element") &&
      node.attributes?.some((attribute) => attribute.type === "Spread")
    )
      found.push(node.start);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(parse(source).html);
  return found;
}
function components(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? components(filename)
      : filename.endsWith(".svelte")
        ? [filename]
        : [];
  });
}
it("keeps the UI build in browser DOM mode, outside the SSR advisory paths", () => {
  expect(options.generate).toBe("dom");
  const result = compile(
    "<p>{value}</p><script>export let value;</script>",
    options,
  );
  expect(result.js.code).not.toContain("create_ssr_component");
  expect(result.js.code).toContain("SvelteComponent");
});
it("detects the advisory form pattern, including dynamic elements and nested blocks", () => {
  expect(
    riskyForms("<form {...attrs}><input name={name}></form>"),
  ).toHaveLength(1);
  expect(
    riskyForms("{#if visible}<svelte:element this={tag} {...attrs} />{/if}"),
  ).toHaveLength(1);
  expect(riskyForms('<form class="login"><input name="login"></form>')).toEqual(
    [],
  );
  expect(riskyForms("<svg {...attrs}></svg>")).toEqual([]);
});
it("keeps maintained Ignis components free of spread attributes on forms or dynamic elements", () => {
  const files = components(root);
  expect(files.length).toBeGreaterThan(0);
  const findings = files.flatMap((file) =>
    riskyForms(fs.readFileSync(file, "utf8")).map(
      (offset) => `${path.relative(root, file)}:${offset}`,
    ),
  );
  expect(findings).toEqual([]);
});
