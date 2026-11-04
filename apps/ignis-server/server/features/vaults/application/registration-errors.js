const messages = {
  INVALID_DIRECTORY: "Vault directory must be one visible directory name",
  INVALID_ROOT: "Vault root must be a real directory",
  INVALID_VAULT: "Vault must be a real directory",
  VAULT_ALIAS: "Remove legacy symlink aliases before registering this vault",
  VAULT_RESERVED: "Vault directory or identity is already registered or reserved",
  OWNER_UNAVAILABLE: "Owner must be an active user",
  SESSION_CHANGED: "Administrator authentication required",
  DIRECTORY_CHANGED: "The directory changed. Reload the vault list and try again",
};
module.exports={messages};
