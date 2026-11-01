// Public limits for receiving content from Android, independent of resource grants.
function readIncomingShareConfig(env = process.env) {
  function integer(name, fallback, minimum, maximum) {
    const value = env[name] ?? String(fallback);
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || Number(value) < minimum || Number(value) > maximum)
      throw new Error(`Invalid ${name}; expected an integer from ${minimum} to ${maximum}`);
    return Number(value);
  }
  return Object.freeze({
    maxMiB: integer('IGNIS_SHARE_MAX_MIB', 32, 1, 1024),
    maxFiles: integer('IGNIS_SHARE_MAX_FILES', 100, 1, 1000),
    ttlMinutes: integer('IGNIS_SHARE_TTL_MINUTES', 60, 0, 525600),
  });
}
function incomingWriteBodyLimit(generalLimit, config, pathname) {
  // Incoming files use binary bodies. Other APIs retain their existing limit.
  return pathname === '/api/fs/writeFile'
    ? Math.max(generalLimit, config.maxMiB * 1024 * 1024)
    : generalLimit;
}
function configureIncomingShareAsset(assets, config) {
  const asset = assets.get('/auth/share-store.js');
  assets.set('/auth/share-store.js', {...asset,
    content: 'globalThis.__ignisIncomingConfig = ' + JSON.stringify(config) + ';\n' + asset.content.toString(),
  });
}
function incomingBinaryParser(config) {
  const parse = require('express').raw({type: 'application/octet-stream', limit: config.maxMiB * 1024 * 1024});
  return (req, res, next) => {
    if (req.method !== 'POST' || !['/api/fs/writeFile', '/api/fs/writeFile/'].includes(req.path) || !req.is('application/octet-stream')) return next();
    const version = req.headers['x-ignis-content-version'];
    if (typeof req.query.path !== 'string' || require('./vault-policy').classifyVaultPath(req.query.path) !== 'content' ||
        (version !== 'new' && (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version))))
      return res.status(400).json({error: 'Invalid binary upload destination or content version'});
    parse(req, res, error => {
      if (error) return res.status(error.status === 413 ? 413 : 400).json({error: 'Invalid binary upload body'});
      req.body = {path: req.query.path, content: req.body, expectedHash: version === 'new' ? null : version};
      next();
    });
  };
}
module.exports = { readIncomingShareConfig, incomingWriteBodyLimit, configureIncomingShareAsset, incomingBinaryParser };
