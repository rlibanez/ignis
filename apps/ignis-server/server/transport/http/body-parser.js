const express = require('express');
const {incomingBinaryParser} = require('../../auth/incoming-share-config');

// Import and sharing routers own their parsers and run before this middleware.
function createBodyParser({settings, incomingShare}) {
  const binary = incomingBinaryParser(incomingShare);
  let json, previousLimit;
  return (req, res, next) => {
    const isBinary = req.method === 'POST' &&
      ['/api/fs/writeFile', '/api/fs/writeFile/'].includes(req.path) &&
      req.is('application/octet-stream');
    const limit = isBinary ? incomingShare.maxMiB * 1024 * 1024
      : Math.min(settings.get('maxBodyBytes'), settings.MAX_BODY_BACKSTOP);
    // Fast rejection is only an optimization. Parsers also count decoded bytes,
    // including chunked bodies and bodies inflated from gzip/deflate.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit)
      return res.status(413).json({error:'Request body too large'});
    if (isBinary) return binary(req, res, next);
    if (limit !== previousLimit) {
      json = express.json({limit});
      previousLimit = limit;
    }
    return json(req, res, next);
  };
}

module.exports = {createBodyParser};
