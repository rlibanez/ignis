const fs = require("node:fs");
const path = require("node:path");
const {validVaultName,validUserDirectory,validDirectory} = require("../application/vault-name");
const fail = code => { throw Object.assign(new Error("Vault storage unavailable"), {code}); };
function ownedDirectory(db, userId, name) {
  const user = db.prepare("SELECT login FROM users WHERE id=? AND status='active'").get(userId);
  if (!user || !validUserDirectory(user.login)) fail("OWNER_UNAVAILABLE");
  if (!validVaultName(name)) fail("INVALID_VAULT_NAME");
  return user.login + "/" + name;
}
// Check every component, not just the final realpath: a user directory must
// never be a symlink, even when it points back inside VAULT_ROOT.
function storagePath(root, directory, {io = fs, missingLeaf = false} = {}) {
  if (!path.isAbsolute(root) || !validDirectory(directory)) fail("VAULT_UNAVAILABLE");
  const parts = directory.split("/");
  const rootStat = io.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("INVALID_VAULT_ROOT");
  const realRoot = io.realpathSync(root);
  let location = root;
  for (const [index, part] of parts.entries()) {
    location = path.join(location, part);
    let stat;
    try { stat = io.lstatSync(location); }
    catch (error) {
      if (missingLeaf && index === 1 && error.code === "ENOENT") return location;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || io.realpathSync(location) !== path.join(realRoot, ...parts.slice(0,index+1)))
      fail("VAULT_UNAVAILABLE");
  }
  return location;
}
function ensureUserDirectory(root, directory, io = fs) {
  if (!validDirectory(directory)) fail("VAULT_UNAVAILABLE");
  const stat = io.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_VAULT_ROOT");
  const parent = path.join(root, directory.split("/")[0]);
  let created=false;
  try { io.lstatSync(parent); }
  catch(error) {
    if(error.code!=="ENOENT")throw error;
    try {io.mkdirSync(parent,{mode:0o700});created=true;}catch(failure){if(failure.code!=="EEXIST")throw failure;}
  }
  storagePath(root,directory,{io,missingLeaf:true});
  if(created){const fd=io.openSync(root,"r");try {io.fsyncSync(fd);}finally {io.closeSync(fd);}}
  return parent;
}
function assertAvailable(db, root, directory) {
  if (!validDirectory(directory)) fail("INVALID_VAULT_NAME");
  if (db.prepare("SELECT 1 FROM vaults WHERE directory=? OR id=?").get(directory,directory) ||
      db.prepare("SELECT 1 FROM vault_renames WHERE source=? OR target=?").get(directory,directory) ||
      db.prepare("SELECT 1 FROM vault_deletions WHERE state='pending' AND source=?").get(directory)) fail("VAULT_EXISTS");
  // Missing parents are fine for a name check; existing parents must be safe.
  const parent = path.join(root,directory.split("/")[0]);
  const rootStat=fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("INVALID_VAULT_ROOT");
  try { fs.lstatSync(parent); } catch (error) { if(error.code==='ENOENT')return;throw error; }
  // Validate the parent without treating an occupied/dangling leaf as available.
  const parentStat=fs.lstatSync(parent);
  if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||fs.realpathSync(parent)!==path.join(fs.realpathSync(root),directory.split('/')[0]))fail('VAULT_UNAVAILABLE');
  const target=path.join(root,directory);
  try { fs.lstatSync(target); } catch (error) { if(error.code==='ENOENT')return;throw error; }
  fail("VAULT_EXISTS");
}
module.exports = {validDirectory,ownedDirectory,storagePath,ensureUserDirectory,assertAvailable};
