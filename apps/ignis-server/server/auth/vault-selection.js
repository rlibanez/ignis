// No implicit default for the future membership boundary. Legacy admin callers
// may explicitly provide their existing default while that boundary is unchanged.
function selectVaultReference(query, body, { defaultVault = null, resolveIdentity = value => value } = {}) {
  const invalid = () => { throw Object.assign(new Error("Invalid vault selection"), { code: "INVALID_VAULT_SELECTION" }); };
  const values = [];
  for (const source of [query, body]) {
    if (!source || !Object.hasOwn(source, "vault")) continue;
    const value = source.vault;
    // Reject arrays/objects, empty selectors and duplicate query parameters.
    if (typeof value !== "string" || !value || value.length > 255 ||
        // eslint-disable-next-line no-control-regex
        /[/\\\x00-\x1f\x7f]/.test(value) || value === "." || value === "..") invalid();
    values.push(value);
  }
  if (!values.length) {
    if (defaultVault === null) return null;
    return selectVaultReference({ vault: defaultVault }, null, { resolveIdentity });
  }
  const selected = resolveIdentity(values[0]);
  if (values.length === 2 && selected !== resolveIdentity(values[1])) invalid();
  return selected;
}
module.exports = { selectVaultReference };
