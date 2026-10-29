const path = require("node:path");

// Only passive media is rendered inline. Unknown and active formats download.
const inlineTypes = new Map(Object.entries({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
  ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".flac": "audio/flac", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
}));

function applyAttachmentPolicy(res, filename) {
  const type = inlineTypes.get(path.extname(filename).toLowerCase());
  res.setHeader("Content-Type", type || "application/octet-stream");
  res.setHeader("Content-Disposition", type ? "inline" : "attachment");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

module.exports = { applyAttachmentPolicy };
