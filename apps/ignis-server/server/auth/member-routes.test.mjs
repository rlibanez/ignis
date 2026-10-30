import { it, expect } from "vitest";
import { createRequire } from "node:module";
const { memberResource } = createRequire(import.meta.url)("./member-routes");
it("opens only reviewed owner APIs and safe static methods", () => {
  for (const [method, route] of [["POST","/api/vault/rename"],["DELETE","/api/vault/remove"],["POST","/api/vault/create"],["POST","/api/proxy"],["GET","/api/vault/list"],["GET","/api/bootstrap"],["POST","/api/fs/writeFile"],["GET","/api/vault-config"]])
    expect(memberResource(method, route)).toBe(true);
  for (const [method, route] of [["GET","/api/vault/owners"],["GET","/api/settings"],["GET","/api/plugins"],["POST","/api/fs/unknown"],["PUT","/api/fs/writeFile"],["POST","/app.js"]])
    expect(memberResource(method, route)).toBe(false);
});
