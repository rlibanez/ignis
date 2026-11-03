function validVaultName(name) {
  return typeof name === "string" && name.length > 0 && Buffer.byteLength(name) <= 255 &&
    name === name.trim() && !name.startsWith(".") && !name.endsWith(".") &&
    // eslint-disable-next-line no-control-regex
    !/[/\\:*?"<>|\x00-\x1f\x7f]/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name);
}
module.exports={validVaultName};
