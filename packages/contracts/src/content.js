// Omitted = intentional replacement; null = create only; SHA-256 = compare-and-swap.
function validContentVersion(value) {
  return value === undefined || value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
}
function writeOutcome(error) {
  const code=typeof error === 'string'?error:error?.code;
  if(code?.endsWith('_UNCERTAIN'))return 'uncertain';
  if(['CONTENT_CONFLICT','SHARE_CONFLICT','CONTENT_VERSION_REQUIRED'].includes(code))return 'conflict';
  if(['EACCES','ENOENT','CONTENT_UNAVAILABLE','SHARE_UNAVAILABLE','VAULT_UNAVAILABLE','AUTH_CONTEXT_CHANGED'].includes(code))return 'denied';
  return 'failed';
}
module.exports={validContentVersion,writeOutcome};
