import { it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { selectRequestVault } = require("./request-selection");
const { createVaultView } = require("../auth/vault-view");
const config = { defaultVaultId: "Foreign", vaults: { Foreign: "/vaults/Foreign", Own: "/vaults/Own" } };
function request(allowed = ["Own"]) {
  return { query: {}, auth: { user: { role: "user" } }, vaultView: createVaultView({
    administrator: false, authorize: id => allowed.includes(id), uuid: id => id,
  }) };
}

it("selects only an accessible initial vault and returns none without memberships", () => {
  expect(selectRequestVault(request(), config, { allowDefault: true })).toBe("Own");
  expect(selectRequestVault(request([]), config, { allowDefault: true })).toBeNull();
  expect(selectRequestVault({ query: {}, auth: { user: { role: "user" } } }, config, { allowDefault: true })).toBeNull();
});

it("requires explicit selection outside initial information and never replaces a forbidden selection", () => {
  const req = request();
  expect(selectRequestVault(req, config)).toBeNull();
  req.query.vault = "Foreign";
  expect(selectRequestVault(req, config, { allowDefault: true })).toBeNull();
  req.query.vault = "Own";
  expect(selectRequestVault(req, config)).toBe("Own");
  req.query = {};
  req.body = { vault: "Own" };
  expect(selectRequestVault(req, config)).toBe("Own");
});

it("checks live access and rejects malformed or conflicting selections", () => {
  const allowed = ["Own"];
  const req = request(allowed);
  req.query.vault = "Own";
  expect(selectRequestVault(req, config)).toBe("Own");
  allowed.length = 0;
  expect(selectRequestVault(req, config)).toBeNull();
  for (const value of ["", ["Own", "Foreign"], "../Own", {}]) {
    req.query.vault = value;
    expect(() => selectRequestVault(req, config)).toThrow();
  }
  req.query.vault = "Own";
  req.body = { vault: "Foreign" };
  expect(() => selectRequestVault(req, config)).toThrow();
});

it("preserves administrator defaults and explicit selections", () => {
  const req = { query: {}, vaultView: createVaultView({ administrator: true }) };
  expect(selectRequestVault(req, config)).toBe("Foreign");
  req.query.vault = "Own";
  expect(selectRequestVault(req, config)).toBe("Own");
});

it("rejects missing or forbidden file/bootstrap selection before accessing disk or cache", async () => {
  const actualConfig = require("../config");
  const saved = { refreshVaults: actualConfig.refreshVaults, getVaultPath: actualConfig.getVaultPath, getVaultPathOrRescan: actualConfig.getVaultPathOrRescan };
  actualConfig.refreshVaults = () => {};
  actualConfig.getVaultPath = actualConfig.getVaultPathOrRescan = () => { throw new Error("Unexpected disk lookup"); };
  try {
    for (const [module, route] of [["../routes/bootstrap", "/"], ["../routes/fs", "/readFile"], ["../routes/fs", "/writeFile"], ["../routes/vault", "/info"]]) {
      const handler = require(module).stack.find(layer => layer.route?.path === route).route.stack[0].handle;
      for (const reference of [undefined, "Foreign"]) {
        // No memberships also ensures initial /info returns the manager path.
        const req = request([]);
        req.headers = {};
        if (reference !== undefined) req.query.vault = reference;
        let status, payload;
        const res = { status: value => { status = value; return res; }, json: value => { payload = value; } };
        await handler(req, res);
        expect(status).toBe(404);
        expect(payload).toEqual({ error: "Vault unavailable" });
      }
    }
  } finally { Object.assign(actualConfig, saved); }
});
