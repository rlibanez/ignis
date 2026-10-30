const express = require("express");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const config = require("../config");
const {
  writeCoalescer,
  watcher,
  encodeContentDispositionFilename,
  resolveVaultPath,
  toVaultRel,
  sanitizeError,
  creationTime,
} = require("@ignis/server-core");
const {
  writeCoalesced,
  getPending,
  estimateSize,
  pendingBuffer,
  flushPending,
  flushPendingSubtree,
  supersedePending,
  supersedePendingSubtree,
} = writeCoalescer;
const bootstrapCache = require("../cache");

const router = express.Router();
const { permit, permitSubtree, filterTree } = require("../vault/resource-policy");
function checkedMutation(req, action) {
  if (req.revalidateVaultFile && !req.revalidateVaultFile()) throw new Error("Resource unavailable");
  return action();
}

// Resolve the vault root for a request. Reads vault ID from query or body.
function getVaultRoot(req, res) {
  const vaultId = require("../vault/request-selection").selectRequestVault(req, config);
  const vaultPath = vaultId && config.getVaultPath(vaultId);

  if (!vaultPath) {
    res.status(404).json({ error: "Vault unavailable" });
    return null;
  }

  req._vaultId = vaultId;
  return vaultPath;
}

function toRelative(vaultRoot, resolved) {
  return toVaultRel(path.relative(vaultRoot, resolved));
}

function isApplicable(event) {
  return (
    !watcher.isIgnoredPath(event.path) &&
    !(event.toPath && watcher.isIgnoredPath(event.toPath))
  );
}

// notify rename to or from ignored directory
async function renameEvent(fromPath, toPath, toResolved) {
  const fromIgnored = watcher.isIgnoredPath(fromPath);
  const toIgnored = watcher.isIgnoredPath(toPath);

  if (fromIgnored === toIgnored) {
    return { type: "rename", path: fromPath, toPath };
  }

  if (toIgnored) {
    return { type: "deleted", path: fromPath };
  }

  const stat = await fs.promises.stat(toResolved).catch(() => null);

  if (!stat) {
    return [];
  }

  return stat.isDirectory()
    ? { type: "folder-created", path: toPath }
    : { type: "created", path: toPath };
}

async function applyToTree(req, events) {
  if (!req._vaultId) {
    return;
  }

  const vaultId = req._vaultId;
  let batch = null;

  try {
    batch = [].concat(await events).filter(isApplicable);

    if (batch.length === 0) {
      return;
    }

    await bootstrapCache.applyMutation(vaultId, batch);
  } catch (e) {
    const paths = batch ? batch.map((event) => event.path).join(", ") : "";

    console.warn(
      `[bootstrap] route apply failed on vault ${vaultId}${paths ? ` for ${paths}` : ""}:`,
      e.message,
    );
  }
}

async function bufferedWriteEvent(resolved, rel, result) {
  const diskStat = await fs.promises.stat(resolved).catch(() => null);

  return {
    type: "modified",
    path: rel,
    stat: {
      size: result.size,
      mtime: result.mtime,
      ctime: diskStat ? creationTime(diskStat) : result.mtime,
    },
  };
}

function guardPath(req, res, source = "query") {
  const vaultRoot = getVaultRoot(req, res);

  if (!vaultRoot) {
    return null;
  }

  const p = source === "body" ? req.body?.path : req.query.path;

  if (p === undefined || p === null) {
    res.status(400).json({ error: "Missing path parameter" });
    return null;
  }

  // Empty string = vault root, which is valid
  const resolved = resolveVaultPath(vaultRoot, p);

  if (!resolved) {
    res.status(403).json({ error: "Path traversal rejected" });
    return null;
  }

  if (req.method === "DELETE" && resolved === path.resolve(vaultRoot)) {
    res.status(403).json({ error: "Use vault management to remove a vault" });
    return null;
  }
  const fileCapabilities = {
    "/readFile": "content.read", "/download": "content.read",
    "/stat": "content.list", "/access": "content.list", "/download-zip": "content.list",
    "/mkdir": "content.write", "/unlink": "content.write", "/rmdir": "content.write", "/rm": "content.write",
    "/writeFile": "content.write", "/appendFile": "content.write", "/utimes": "content.write",
  };
  const capability = fileCapabilities[req.route?.path];
  if (capability && req.authorizeVaultFile &&
      !req.authorizeVaultFile(req._vaultId, capability, toRelative(vaultRoot, resolved))) {
    res.status(404).json({ error: "Resource unavailable" });
    return null;
  }
  req._vaultRoot = vaultRoot;
  return resolved;
}

// GET /api/fs/stat?path=...
router.get("/stat", async (req, res) => {
  const resolved = guardPath(req, res);

  if (!resolved) {
    return;
  }

  try {
    // If a coalesced write is pending, report its size instead of stale disk data
    const buffered = getPending(resolved);

    if (buffered) {
      const diskStat = await fs.promises.stat(resolved).catch(() => null);
      const size = estimateSize(buffered.data, buffered.encoding);

      res.json({
        type: "file",
        size,
        mtime: Date.now(),
        ctime: diskStat ? creationTime(diskStat) : Date.now(),
      });

      return;
    }

    const stat = await fs.promises.stat(resolved);

    res.json({
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: creationTime(stat),
    });
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json(sanitizeError(e));
  }
});

// GET /api/fs/readFile?path=...&encoding=...
router.get("/readFile", async (req, res) => {
  const resolved = guardPath(req, res);

  if (!resolved) {
    return;
  }

  try {
    const stat = await fs.promises.stat(resolved);

    if (stat.isDirectory()) {
      return res.status(400).json({
        error: "EISDIR: illegal operation on a directory",
        code: "EISDIR",
      });
    }

    // Serve buffered content if a coalesced write is pending for this path
    const buffered = getPending(resolved);

    if (buffered) {
      const encoding = req.query.encoding;

      if (encoding === "utf8" || encoding === "utf-8") {
        res.type("text/plain").send(buffered.data);
      } else {
        res.type("application/octet-stream").send(buffered.data);
      }

      return;
    }

    const encoding = req.query.encoding;

    if (encoding === "utf8" || encoding === "utf-8") {
      const data = await fs.promises.readFile(resolved, "utf-8");

      res.type("text/plain").send(data);
    } else {
      const data = await fs.promises.readFile(resolved);

      res.type("application/octet-stream").send(data);
    }
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json(sanitizeError(e));
  }
});

// POST /api/fs/writeFile { path, content, encoding?, vault?, expectedHash? }
// Omitted version: deliberate plugin replacement. Provided version: strict CAS.
router.post("/writeFile", async (req, res) => {
  const resolved = guardPath(req, res, "body");

  if (!resolved) {
    return;
  }

  try {
    const rel = toRelative(req._vaultRoot, resolved);
    const guarded = req.writeVaultContent && require("../auth/vault-policy").classifyVaultPath(rel) === "content";
    if (guarded && req.body.expectedHash !== undefined && req.body.expectedHash !== null &&
        (typeof req.body.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(req.body.expectedHash)))
      return res.status(428).json({error:"Invalid content version precondition.",code:"CONTENT_VERSION_REQUIRED"});
    // Ensure parent directory exists
    const dir = path.dirname(resolved);
    await fs.promises.mkdir(dir, { recursive: true });

    const encoding = req.body.encoding || "utf-8";
    let data = req.body.content;

    if (req.body.base64) {
      data = Buffer.from(req.body.content, "base64");
    }

    if (req.revalidateVaultFile && !req.revalidateVaultFile()) { res.destroy(); return; }
    const result = guarded
      ? await req.writeVaultContent(req.vaultUUID(req._vaultId),rel,Buffer.isBuffer(data)?data:Buffer.from(data,encoding === "binary"?"utf8":encoding),req.body.expectedHash)
      : await writeCoalesced(resolved, data, encoding);
    const buffered = getPending(resolved) !== null;

    res.json({ ok: true, mtime: result.mtime, size: result.size, ...(result.etag?{etag:result.etag}:{}) });

    applyToTree(
      req,
      buffered
        ? bufferedWriteEvent(resolved, rel, result)
        : { type: "modified", path: rel },
    );
  } catch (e) {
    if(e.code === "CONTENT_CONFLICT") return res.status(409).json({error:"The file changed since it was read. Download your changes before reloading.",code:e.code});
    if(e.code === "SHARE_UNAVAILABLE") return res.status(404).json({error:"Resource unavailable",code:"CONTENT_UNAVAILABLE"});
    if(e.code === "SHARE_WRITE_UNCERTAIN") return res.status(503).json({error:"The save could not be confirmed. Preserve your changes before reloading.",code:"CONTENT_WRITE_UNCERTAIN"});
    res.status(500).json(sanitizeError(e));
  }
});

// POST /api/fs/appendFile { path, content, vault? }
router.post("/appendFile", async (req, res) => {
  const resolved = guardPath(req, res, "body");

  if (!resolved) {
    return;
  }

  try {
    await flushPending(resolved);
    if (req.revalidateVaultFile && !req.revalidateVaultFile()) { res.destroy(); return; }
    // No asynchronous disk write may outlive a version-checked publication.
    checkedMutation(req,()=>fs.appendFileSync(resolved, req.body.content, "utf-8"));

    const rel = toRelative(req._vaultRoot, resolved);

    res.json({ ok: true });

    applyToTree(req, { type: "modified", path: rel });
  } catch (e) {
    res.status(500).json(sanitizeError(e));
  }
});

// POST /api/fs/mkdir { path, recursive?, vault? }
router.post("/mkdir", async (req, res) => {
  const resolved = guardPath(req, res, "body");

  if (!resolved) {
    return;
  }

  try {
    await supersedePending(resolved, () =>
      checkedMutation(req, () => fs.promises.mkdir(resolved, { recursive: !!req.body.recursive })),
    );

    const rel = toRelative(req._vaultRoot, resolved);

    res.json({ ok: true });

    applyToTree(req, { type: "folder-created", path: rel });
  } catch (e) {
    res.status(500).json(sanitizeError(e));
  }
});

// POST /api/fs/rename { oldPath, newPath, vault? }
router.post("/rename", async (req, res) => {
  const vaultRoot = getVaultRoot(req, res);

  if (!vaultRoot) {
    return;
  }

  if (!req.body?.oldPath || !req.body?.newPath) {
    return res.status(400).json({ error: "Missing oldPath or newPath" });
  }

  const oldResolved = resolveVaultPath(vaultRoot, req.body.oldPath);
  const newResolved = resolveVaultPath(vaultRoot, req.body.newPath);

  if (oldResolved === path.resolve(vaultRoot) || newResolved === path.resolve(vaultRoot)) {
    return res.status(403).json({ error: "Use vault management to rename a vault" });
  }

  if (!oldResolved || !newResolved) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    if (!await permitSubtree(req, vaultRoot, oldResolved, "content.write", newResolved) ||
        !await permitSubtree(req, vaultRoot, newResolved, "content.write"))
      return res.status(404).json({ error: "Resource unavailable" });
    await flushPendingSubtree(oldResolved);
    // Drop the destination's buffer so a stale write cannot land on the renamed file.
    if(req.renameVaultResource) {
      await flushPendingSubtree(newResolved);
      await supersedePendingSubtree(oldResolved,()=>supersedePendingSubtree(newResolved,()=>
        checkedMutation(req,()=>req.renameVaultResource(req._vaultId,toRelative(vaultRoot,oldResolved),toRelative(vaultRoot,newResolved)))));
    } else await supersedePending(newResolved, () =>
      checkedMutation(req, () => fs.promises.rename(oldResolved, newResolved)),
    );

    res.json({ ok: true });

    applyToTree(
      req,
      renameEvent(
        toRelative(vaultRoot, oldResolved),
        toRelative(vaultRoot, newResolved),
        newResolved,
      ),
    );
  } catch (e) {
    if(e.code === "SHARE_MOVE_BOUNDARY") return res.status(409).json({error:"Move within the same shared folder without crossing another shared folder boundary.",code:e.code});
    res.status(500).json(sanitizeError(e));
  }
});

// POST /api/fs/copyFile { src, dest, vault? }
router.post("/copyFile", async (req, res) => {
  const vaultRoot = getVaultRoot(req, res);

  if (!vaultRoot) {
    return;
  }

  if (!req.body?.src || !req.body?.dest) {
    return res.status(400).json({ error: "Missing src or dest" });
  }

  const srcResolved = resolveVaultPath(vaultRoot, req.body.src);
  const destResolved = resolveVaultPath(vaultRoot, req.body.dest);

  if (!srcResolved || !destResolved) {
    return res.status(403).json({ error: "Invalid path" });
  }

  try {
    if (!permit(req, vaultRoot, srcResolved, "content.read") || !permit(req, vaultRoot, destResolved, "content.write"))
      return res.status(404).json({ error: "Resource unavailable" });
    await flushPending(srcResolved);
    await supersedePending(destResolved, () =>
      checkedMutation(req, () => fs.promises.copyFile(srcResolved, destResolved)),
    );

    res.json({ ok: true });

    applyToTree(req, {
      type: "modified",
      path: toRelative(vaultRoot, destResolved),
    });
  } catch (e) {
    res.status(500).json(sanitizeError(e));
  }
});

// DELETE /api/fs/unlink?path=...
router.delete("/unlink", async (req, res) => {
  const resolved = guardPath(req, res);

  if (!resolved) {
    return;
  }

  const rel = toRelative(req._vaultRoot, resolved);

  try {
    await supersedePending(resolved, () =>
      checkedMutation(req, () => fs.promises.unlink(resolved)).catch((e) => {
        // already gone counts as deleted
        if (e.code !== "ENOENT") {
          throw e;
        }
      }),
    );

    res.json({ ok: true });

    applyToTree(req, { type: "deleted", path: rel });
  } catch (e) {
    res.status(500).json(sanitizeError(e));
  }
});

// DELETE /api/fs/rmdir?path=...
router.delete("/rmdir", async (req, res) => {
  const resolved = guardPath(req, res);

  if (!resolved) {
    return;
  }

  try {
    await supersedePendingSubtree(resolved, () => checkedMutation(req, () => fs.promises.rmdir(resolved)));

    const rel = toRelative(req._vaultRoot, resolved);

    res.json({ ok: true });

    applyToTree(req, { type: "deleted", path: rel });
  } catch (e) {
    res.status(500).json(sanitizeError(e));
  }
});

// DELETE /api/fs/rm?path=...&recursive=true
router.delete("/rm", async (req, res) => {
  const resolved = guardPath(req, res);

  if (!resolved) {
    return;
  }

  try {
    const recursive = req.query.recursive === "true";
    if (recursive && !await permitSubtree(req, req._vaultRoot, resolved, "content.write"))
      return res.status(404).json({ error: "Resource unavailable" });
    const remove = () => checkedMutation(req, () => fs.promises.rm(resolved, { recursive }));

    if (recursive) {
      await supersedePendingSubtree(resolved, remove);
    } else {
      await supersedePending(resolved, remove);
    }

    const rel = toRelative(req._vaultRoot, resolved);

    res.json({ ok: true });

    applyToTree(req, { type: "deleted", path: rel });
  } catch (e) {
    res.status(500).json(sanitizeError(e));
  }
});

router.get("/access", async (req, res) => {
  const resolved = guardPath(req, res);

  if (!resolved) {
    return;
  }

  try {
    await fs.promises.access(resolved);

    res.json({ ok: true });
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json(sanitizeError(e));
  }
});

// POST /api/fs/utimes { path, atime, mtime, vault? }
router.post("/utimes", async (req, res) => {
  const resolved = guardPath(req, res, "body");

  if (!resolved) {
    return;
  }

  try {
    await flushPending(resolved);
    if (req.revalidateVaultFile && !req.revalidateVaultFile()) { res.destroy(); return; }
    await fs.promises.utimes(
      resolved,
      req.body.atime / 1000,
      req.body.mtime / 1000,
    );

    const stat = await fs.promises.stat(resolved);

    if (stat.isDirectory()) {
      res.json({ type: "directory" });
      return;
    }

    const times = {
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: creationTime(stat),
    };

    res.json({ type: "file", ...times });

    applyToTree(req, {
      type: "modified",
      path: toRelative(req._vaultRoot, resolved),
      stat: times,
    });
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json(sanitizeError(e));
  }
});

// POST /api/fs/batch-read { paths, vault } - bulk read text file contents
// Used by the indexer pre-fetcher to avoid N round trips during startup.
router.post("/batch-read", async (req, res) => {
  const vaultRoot = getVaultRoot(req, res);

  if (!vaultRoot) {
    return;
  }

  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];

  // The indexer prefetcher (the only caller) batches at 50, so a much larger list is not legitimate.
  if (paths.length > 1000) {
    return res.status(400).json({ error: "too many paths in batch-read" });
  }

  if (paths.length === 0) {
    return res.json({ files: {} });
  }

  const files = {};

  await Promise.all(
    paths.map(async (relPath) => {
      const resolved = resolveVaultPath(vaultRoot, relPath);

      if (!resolved || !permit(req, vaultRoot, resolved, "content.read")) {
        return;
      }

      try {
        const buffered = getPending(resolved);

        if (buffered) {
          if (typeof buffered.data === "string") {
            files[relPath] = buffered.data;
          } else if (
            buffered.encoding === "utf8" ||
            buffered.encoding === "utf-8"
          ) {
            files[relPath] = buffered.data.toString("utf-8");
          }
          return;
        }

        const data = await fs.promises.readFile(resolved, "utf-8");
        files[relPath] = data;
      } catch {
        // Skip unreadable files silently. The client falls back to a
        // normal readFile when a path isn't in the response.
      }
    }),
  );

  res.json({ files });
});

// GET /api/fs/tree?vault=... returns the full recursive file tree with metadata
router.get("/tree", async (req, res) => {
  const vaultRoot = getVaultRoot(req, res);

  if (!vaultRoot) {
    return;
  }

  try {
    // grab the tree from the bootstrap cache.
    const entry = await bootstrapCache.getOrBuild(req._vaultId);

    if (!entry) {
      return res.status(404).json({ error: "Vault not found" });
    }

    const tree = filterTree(req, vaultRoot, entry.response.tree);
    const etag = req.authorizeVaultFile
      ? '"' + require("node:crypto").createHash("sha256").update(JSON.stringify([entry.etag, tree])).digest("hex") + '"'
      : entry.etag;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }

    res.json(tree);
  } catch (e) {
    res.status(500).json(sanitizeError(e));
  }
});

// GET /api/fs/download?path=...&vault=...
router.get("/download", async (req, res) => {
  const resolved = guardPath(req, res);

  if (!resolved) {
    return;
  }

  try {
    const filename = path.basename(resolved);
    const buffered = getPending(resolved);

    if (buffered) {
      const body = pendingBuffer(buffered.data, buffered.encoding);

      res.setHeader(
        "Content-Disposition",
        encodeContentDispositionFilename(filename),
      );
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(body);
    }

    const stat = await fs.promises.stat(resolved);

    if (stat.isDirectory()) {
      return res
        .status(400)
        .json({ error: "Use /download-zip for directories" });
    }

    res.setHeader(
      "Content-Disposition",
      encodeContentDispositionFilename(filename),
    );
    res.sendFile(resolved);
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json(sanitizeError(e));
  }
});

// GET /api/fs/download-zip?path=...&vault=...
router.get("/download-zip", async (req, res) => {
  const resolved = guardPath(req, res);

  if (!resolved) {
    return;
  }

  try {
    const stat = await fs.promises.stat(resolved);

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Not a directory" });
    }

    // Persist buffered writes under the directory so archiver reads current bytes from disk.
    await flushPendingSubtree(resolved);

    const folderName = path.basename(resolved);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      encodeContentDispositionFilename(folderName + ".zip"),
    );

    const archive = archiver("zip", { zlib: { level: 5 } });

    archive.on("error", (err) => {
      res.status(500).end();
    });

    archive.pipe(res);
    // Skip symlinked entries so the zip cannot carry a link that escapes the vault on extraction.
    archive.directory(resolved, folderName, (entry) =>
      (entry.stats && entry.stats.isSymbolicLink()) ||
      !permit(req, req._vaultRoot, path.resolve(resolved, entry.name), entry.stats?.isDirectory() ? "content.list" : "content.read") ? false : entry,
    );
    archive.finalize();
  } catch (e) {
    res.status(e.code === "ENOENT" ? 404 : 500).json(sanitizeError(e));
  }
});

module.exports = router;
