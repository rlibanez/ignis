const fs=require('node:fs'),path=require('node:path');
const {classifyVaultPath}=require('../../vaults/application/vault-policy');
const fail=(code='SHARE_UNAVAILABLE')=>{throw Object.assign(new Error('Content unavailable'),{code});};
function canonical(value, empty = false) {
  if (typeof value !== "string" || value.length > 1024 || (!value && !empty) || (value && classifyVaultPath(value) !== "content")) fail("INVALID_SHARE_PATH");
  return value;
}
function inspect(root, relative, missing = false, trash = false) {
  if(trash && relative.startsWith(".trash/"))canonical(relative.slice(7));else canonical(relative, true);
  let filename = root, stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const parts = relative.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    filename = path.join(filename, parts[i]);
    try { stat = fs.lstatSync(filename); }
    catch (error) { if (missing && error.code === "ENOENT" && i === parts.length - 1) return { filename, stat:null }; throw error; }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1) ||
      (i < parts.length - 1 && !stat.isDirectory())) fail();
  }
  return { filename, stat };
}
module.exports={canonical,inspect};
