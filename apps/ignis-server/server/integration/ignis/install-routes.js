const express = require('express');
const path = require('node:path');
const compression = require('compression');
const {resolveVaultPath} = require('@ignis/server-core');
const {cacheControlFor} = require('../../static/cache-headers');
const {buildIndexHtml} = require('../../static/index-html');

function installRoutes({app,auth,authConfig,config,settings,writeCoalescer}) {
const REPO_ROOT=path.resolve(__dirname,'../../../../..');
app.use(require('../../transport/http/body-parser').createBodyParser({settings, incomingShare:authConfig.incomingShare}));
app.use(auth.revalidate);
app.use(compression());

const pluginRoutes = require("../../routes/plugins");
const fsRoutes = require("../../routes/fs");
const vaultRoutes = require("../../routes/vault");
const proxyRoutes = require("../../routes/proxy");
const versionRoutes = require("../../routes/version");
const settingsRoutes = require("../../routes/settings");
const bootstrapRoutes = require("../../routes/bootstrap");

app.use("/assets", express.static(path.join(__dirname, "../../assets")));

// Wait for in-flight file/plugin/bootstrap handlers before a registered rename.
for (const router of [fsRoutes, pluginRoutes, bootstrapRoutes]) {
  require("../../vault/lifecycle").trackRouterWork(router);
}
app.use("/api/fs", fsRoutes);
app.use("/api/vault", vaultRoutes);
app.use("/api/proxy", proxyRoutes);
app.use("/api/version", versionRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/plugins", pluginRoutes);
app.use("/api/bootstrap", bootstrapRoutes);

// Serve vault files for resource URLs (images, attachments, etc.)
// Vault ID is the first path segment: /vault-files/<vault-id>/path/to/file
app.use("/vault-files", (req, res, next) => {
  // Extract vault ID from the first path segment
  const parts = req.path.split("/").filter(Boolean);

  if (parts.length === 0) {
    return res.status(400).json({ error: "Missing vault ID" });
  }

  let vaultId;
  try { vaultId = auth.resolveVaultDirectory(decodeURIComponent(parts[0])); }
  catch { return res.status(404).json({ error: "Vault unavailable" }); }
  const vaultPath = config.getVaultPath(vaultId);

  if (!vaultPath) {
    return res.status(404).json({ error: "Vault not found" });
  }

  let resolved = null;

  try {
    const relPath = parts.slice(1).map(decodeURIComponent).join("/");
    resolved = relPath ? resolveVaultPath(vaultPath, relPath) : null;
  } catch {
    // Invalid paths must not fall through to a different static-file resolver.
  }

  if (!resolved) return res.status(404).json({ error: "Resource unavailable" });
  if (req.authorizeVaultFile && !req.authorizeVaultFile(vaultId, "content.read", path.relative(vaultPath, resolved).split(path.sep).join("/")))
    return res.status(404).json({ error: "Resource unavailable" });
  require("../../vault/attachment-policy").applyAttachmentPolicy(res, resolved);
  const buffered = writeCoalescer.getPending(resolved);

  // Serve buffered content if exists.
  if (buffered) {
    const body = writeCoalescer.pendingBuffer(buffered.data, buffered.encoding);

    return res.send(body);
  }

  // Rewrite req.url to strip the vault ID prefix, then serve statically
  req.url = "/" + parts.slice(1).join("/");
  express.static(vaultPath, { index: false, redirect: false })(req, res, error => {
    if (error) return next(error);
    // A missing attachment must not fall through to application assets.
    res.status(404).end();
  });
});

app.get(["/", "/index.html"], (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "no-cache");
  res.send(buildIndexHtml());
});

app.get("/favicon.png", (req, res) => {
  res.sendFile(path.join(REPO_ROOT, "images", "favicon.png"));
});

// Cache headers for static assets, by version query.
// Set before express.static, which only fills Cache-Control when it is not already present.
app.use((req, res, next) => {
  const cacheControl = cacheControlFor(req.path, !!req.query.v);

  if (cacheControl) {
    res.setHeader("Cache-Control", cacheControl);
  }

  next();
});

app.use(express.static(path.join(REPO_ROOT, "packages", "ui", "dist")));
app.use(express.static(path.join(REPO_ROOT, "packages", "shim", "dist")));

app.use(express.static(config.obsidianAssetsPath));

}
module.exports = {installRoutes};
