const zlib = require("zlib");
const { compressedEtags, compressing } = require("./state");

function preCompress(buf) {
  return Promise.all([
    new Promise((resolve, reject) => {
      zlib.brotliCompress(
        buf,
        { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
        (err, result) => (err ? reject(err) : resolve(result)),
      );
    }),
    new Promise((resolve, reject) => {
      zlib.gzip(buf, { level: 6 }, (err, result) =>
        err ? reject(err) : resolve(result),
      );
    }),
  ]).then(([br, gz]) => ({ br, gz }));
}

function markCompressionStale(entry) {
  compressedEtags.delete(entry);
}

function compressionKey(entry) {
  return JSON.stringify([entry.etag, entry.response.vaultList, entry.response.vault?.uuid]);
}

function getOrCompress(entry) {
  const key = compressionKey(entry);
  // bust compression cache.
  if (compressedEtags.get(entry) === key) {
    return Promise.resolve(entry.compressed);
  }

  const etag = key;
  const inFlight = compressing.get(entry);

  if (inFlight && inFlight.etag === etag) {
    return inFlight.promise;
  }

  const jsonBuf = Buffer.from(JSON.stringify(entry.response));
  const run = { etag, promise: null };

  run.promise = preCompress(jsonBuf)
    .then((compressed) => {
      if (compressionKey(entry) === etag) {
        entry.compressed = compressed;
        compressedEtags.set(entry, etag);
      }

      return compressed;
    })
    .catch((e) => {
      console.warn("[bootstrap] precompression failed:", e.message);

      return {};
    })
    .finally(() => {
      if (compressing.get(entry) === run) {
        compressing.delete(entry);
      }
    });

  compressing.set(entry, run);

  return run.promise;
}

module.exports = {
  preCompress,
  markCompressionStale,
  getOrCompress,
};
