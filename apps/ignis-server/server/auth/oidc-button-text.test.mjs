import { it, expect } from "vitest";
import { createRequire } from "node:module";
const { readAuthConfig } = createRequire(import.meta.url)("./http-policy");
const config = (text) => readAuthConfig({
  IGNIS_PUBLIC_ORIGIN: "https://ignis.example",
  ...(text === undefined ? {} : { IGNIS_OIDC_BUTTON_TEXT: text }),
});
it.each([undefined, "", "   "])("defaults blank button text: %s", (text) => {
  expect(config(text).oidcButtonText).toBe("OpenID Connect");
});
it("accepts custom text", () => {
  expect(config("  Authentik  ").oidcButtonText).toBe("Authentik");
  expect(config("a".repeat(80)).oidcButtonText.length).toBe(80);
});
it.each(["a".repeat(81), "a" + String.fromCharCode(10) + "b",
  "a" + String.fromCharCode(0) + "b", "a" + String.fromCharCode(8238) + "b"])(
  "rejects invalid labels", (text) => {
    expect(() => config(text)).toThrow("Invalid IGNIS_OIDC_BUTTON_TEXT");
  },
);
