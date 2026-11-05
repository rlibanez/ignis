function validVaultName(name) {
  return typeof name === "string" && name.length > 0 && Buffer.byteLength(name) <= 255 &&
    name === name.trim() && !name.startsWith(".") && !name.endsWith(".") &&
    // eslint-disable-next-line no-control-regex
    !/[/\\:*?"<>|\x00-\x1f\x7f]/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name);
}
const validUserDirectory = name => typeof name === "string" && /^[a-z0-9][a-z0-9._-]{2,63}$/.test(name);
function validDirectory(directory) {
  if (typeof directory !== "string") return false;
  const parts = directory.split("/");
  return parts.length === 2 && validUserDirectory(parts[0]) && validVaultName(parts[1]);
}
module.exports={validVaultName,validUserDirectory,validDirectory};
