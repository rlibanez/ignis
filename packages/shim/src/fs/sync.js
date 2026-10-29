import { markSentOp } from "./echo-guard.js";
import { isInputCachePath, inputCacheGet } from "./input-cache.js";
import {
  applyReadTransform,
  applyWriteTransform,
  resolvePath,
  resolvePathInfo,
} from "./transforms.js";
import { hasVirtualFile, getVirtualFile } from "./virtual-files.js";
import { cancelPending, enqueueWrite, hasPending } from "./write-coalescer.js";
import { createUtimes } from "./utimes.js";

export function createFsSync(metadataCache, contentCache, transport, privateFiles = null) {
  const commitUtimes = createUtimes(metadataCache, transport);

  return {
    existsSync(path) {
      const probe = privateFiles?.caseProbe?.("exists", path, resolvePath(path));
      if (probe) return probe.value;
      if (privateFiles) {
        try {
          const privatePath = privateFiles.select(path, resolvePath(path), true);
          if (privatePath) { privateFiles.statSync(privatePath); return true; }
        } catch (error) {
          if (["UNSUPPORTED_CONFIGURATION", "ENOENT"].includes(error.code)) return false;
          throw error;
        }
      }
      if (isInputCachePath(path) && inputCacheGet(path) !== null) {
        return true;
      }

      const resolved = resolvePath(path);
      return metadataCache.has(resolved);
    },

    statSync(path) {
      const privatePath = privateFiles?.select(path, resolvePath(path), true);
      if (privatePath) return privateFiles.statSync(privatePath);
      if (isInputCachePath(path) && inputCacheGet(path) !== null) {
        const data = inputCacheGet(path);
        const size = data ? data.length || data.byteLength || 0 : 0;

        return {
          size,
          mtime: new Date(),
          ctime: new Date(),
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        };
      }

      const resolved = resolvePath(path);
      const stat = metadataCache.toStat(resolved);

      if (!stat) {
        const err = new Error(
          `ENOENT: no such file or directory, stat '${path}'`,
        );
        err.code = "ENOENT";
        throw err;
      }

      return stat;
    },

    accessSync(path, mode) {
      const privatePath = privateFiles?.select(path, resolvePath(path), true);
      if (privatePath) return privateFiles.accessSync(privatePath, mode);
      if (isInputCachePath(path) && inputCacheGet(path) !== null) {
        return;
      }

      const resolved = resolvePath(path);

      if (!metadataCache.has(resolved)) {
        const err = new Error(
          `ENOENT: no such file or directory, access '${path}'`,
        );
        err.code = "ENOENT";
        throw err;
      }
    },

    readFileSync(path, encoding) {
      if (typeof encoding === "object") {
        encoding = encoding?.encoding;
      }

      const wantText = encoding === "utf8" || encoding === "utf-8";
      const { resolved, redirected } = resolvePathInfo(path);
      const privatePath = privateFiles?.select(path, resolved, false, true);
      if (privatePath) return privateFiles.readSync(privatePath, encoding);

      // Virtual plugin source overrides any cache or transport version.
      if (hasVirtualFile(resolved)) {
        const content = getVirtualFile(resolved);

        if (wantText) {
          return typeof content === "string"
            ? content
            : new TextDecoder().decode(content);
        }

        return typeof content === "string"
          ? new TextEncoder().encode(content)
          : content;
      }

      const meta = metadataCache.get(resolved);
      if (meta && meta.type === "directory") {
        const e = new Error("EISDIR: illegal operation on a directory, read");
        e.code = "EISDIR";
        throw e;
      }

      let result = null;

      // Check input cache for files picked via browser file dialogs.
      if (isInputCachePath(path)) {
        const inputData = inputCacheGet(path);

        if (inputData !== null) {
          result = inputData;
        }
      }

      if (result === null) {
        result = contentCache.get(resolved);
      }

      // The metadata cache is kept fresh by the filewatcher and a miss here genuinely means the file is absent.
      // Redirected paths fall through to the transport, so we can't trust the cache for them, but non-redirected misses are definitive.
      if (result === null && !meta && !redirected) {
        const e = new Error(
          `ENOENT: no such file or directory, open '${path}'`,
        );
        e.code = "ENOENT";
        throw e;
      }

      if (result === null) {
        // A resolver can map a path onto a physical target that does not exist yet, so a redirected miss retries the original path before failing.
        try {
          result = transport.readFileSync(resolved, encoding);
        } catch (e) {
          if (redirected && e.code === "ENOENT") {
            console.warn(
              "[shim:fs] readFileSync cache miss, using sync XHR:",
              path,
            );
            result = transport.readFileSync(path, encoding);
          } else {
            throw e;
          }
        }

        contentCache.set(resolved, result);
      }

      // Apply registered read transforms (e.g., patching synced config files).
      result = applyReadTransform(resolved, result);

      if (wantText) {
        return typeof result === "string"
          ? result
          : new TextDecoder().decode(result);
      }

      return result;
    },

    writeFileSync(path, data, encoding) {
      const probe = privateFiles?.caseProbe?.("write", path, resolvePath(path), data);
      if (probe) return probe.value;
      if (typeof encoding === "object") {
        encoding = encoding?.encoding;
      }

      const resolved = resolvePath(path);
      const privatePath = privateFiles?.select(path, resolved);
      if (privatePath) return privateFiles.writeSync(privatePath, data, encoding);
      const transformed = applyWriteTransform(resolved, data);

      contentCache.set(resolved, transformed);

      const size =
        typeof transformed === "string"
          ? transformed.length
          : transformed.byteLength || 0;

      const applyResult = (result) => {
        metadataCache.set(resolved, {
          type: "file",
          size: result.size || size,
          mtime: result.mtime,
          ctime: metadataCache.get(resolved)?.ctime || Date.now(),
        });
      };

      metadataCache.set(resolved, {
        type: "file",
        size,
        mtime: Date.now(),
        ctime: metadataCache.get(resolved)?.ctime || Date.now(),
      });

      if (hasPending(resolved)) {
        cancelPending(resolved);
      }

      // Fire-and-forget.
      enqueueWrite(resolved, transformed, encoding, applyResult, {
        silent: true,
      }).catch(() => {});
    },

    unlinkSync(path) {
      const probe = privateFiles?.caseProbe?.("unlink", path, resolvePath(path));
      if (probe) return probe.value;
      privateFiles?.assertOrdinary(path, resolvePath(path));
      const resolved = resolvePath(path);

      markSentOp(resolved);
      contentCache.delete(resolved);
      metadataCache.delete(resolved);

      // Fire-and-forget. suppress ENOENT (file already gone)
      transport.unlink(resolved).catch((e) => {
        if (e.code !== "ENOENT") {
          console.error(
            "[shim:fs] unlinkSync background delete failed:",
            resolved,
            e,
          );
        }
      });
    },

    readdirSync(path) {
      const privatePath = privateFiles?.select(path, resolvePath(path), true);
      if (privatePath) return privateFiles.readdirSync(privatePath);
      const entries = metadataCache.readdir(path);
      const names = entries.map((e) => e.name);
      if (privateFiles && ["", "/", "."].includes(path)) return privateFiles.rootEntries(names);
      return names;
    },

    lstatSync(path) {
      // No symlinks in our context.
      return this.statSync(path);
    },

    mkdirSync(path, options) {
      if (privateFiles?.ensureDirectory?.(path, resolvePath(path))) return;
      privateFiles?.assertOrdinary(path, resolvePath(path));
      const recursive =
        typeof options === "object" ? !!options.recursive : !!options;

      const resolved = resolvePath(path);

      markSentOp(resolved);
      metadataCache.set(resolved, { type: "directory" });

      transport.mkdir(resolved, recursive).catch((e) => {
        console.error(
          "[shim:fs] mkdirSync background create failed:",
          resolved,
          e,
        );
      });
    },

    rmdirSync(path) {
      privateFiles?.assertOrdinary(path, resolvePath(path));
      const resolved = resolvePath(path);

      markSentOp(resolved);
      metadataCache.delete(resolved);

      transport.rmdir(resolved).catch((e) => {
        console.error(
          "[shim:fs] rmdirSync background remove failed:",
          resolved,
          e,
        );
      });
    },

    rmSync(path, options) {
      privateFiles?.assertOrdinary(path, resolvePath(path));
      const recursive =
        typeof options === "object" ? !!options.recursive : false;

      const resolved = resolvePath(path);

      markSentOp(resolved);
      metadataCache.delete(resolved);
      contentCache.delete(resolved);

      transport.rm(resolved, recursive).catch((e) => {
        console.error(
          "[shim:fs] rmSync background remove failed:",
          resolved,
          e,
        );
      });
    },

    renameSync(oldPath, newPath) {
      privateFiles?.assertOrdinary(oldPath, resolvePath(oldPath));
      privateFiles?.assertOrdinary(newPath, resolvePath(newPath));
      const resolvedOld = resolvePath(oldPath);
      const resolvedNew = resolvePath(newPath);

      markSentOp(resolvedOld);
      markSentOp(resolvedNew);

      for (const key of metadataCache.rename(resolvedOld, resolvedNew)) {
        contentCache.delete(key);
      }

      const content = contentCache.get(resolvedOld);

      if (content !== null) {
        contentCache.set(resolvedNew, content);
        contentCache.delete(resolvedOld);
      }

      transport.rename(resolvedOld, resolvedNew).catch((e) => {
        console.error(
          "[shim:fs] renameSync background rename failed:",
          resolvedOld,
          e,
        );
      });
    },

    copyFileSync(src, dest) {
      privateFiles?.assertOrdinary(src, resolvePath(src));
      privateFiles?.assertOrdinary(dest, resolvePath(dest));
      const resolvedSrc = resolvePath(src);
      const resolvedDest = resolvePath(dest);

      markSentOp(resolvedDest);

      // Optimistically mirror the source so a sync read right after sees it.
      const content = contentCache.get(resolvedSrc);

      if (content !== null) {
        contentCache.set(resolvedDest, content);
      }

      const srcMeta = metadataCache.get(resolvedSrc);

      if (srcMeta) {
        metadataCache.set(resolvedDest, { ...srcMeta });
      }

      transport
        .copyFile(src, resolvedDest)
        .then(() => transport.stat(resolvedDest))
        .then((meta) => metadataCache.set(resolvedDest, meta))
        .catch((e) => {
          console.error(
            "[shim:fs] copyFileSync background copy failed:",
            resolvedDest,
            e,
          );
        });
    },

    appendFileSync(path, data) {
      privateFiles?.assertOrdinary(path, resolvePath(path));
      const resolved = resolvePath(path);

      markSentOp(resolved);
      contentCache.invalidate(resolved);

      transport
        .appendFile(resolved, data)
        .then(() => transport.stat(resolved))
        .then((meta) => metadataCache.set(resolved, meta))
        .catch((e) => {
          console.error(
            "[shim:fs] appendFileSync background append failed:",
            resolved,
            e,
          );
        });
    },

    utimesSync(path, atime, mtime) {
      privateFiles?.assertOrdinary(path, resolvePath(path));
      commitUtimes(path, atime, mtime);
    },

    lutimesSync(path, atime, mtime) {
      privateFiles?.assertOrdinary(path, resolvePath(path));
      commitUtimes(path, atime, mtime);
    },

    chmodSync(path) {
      privateFiles?.assertOrdinary(path, resolvePath(path));
      // The vault FS does not model permission bits. No-op.
    },
  };
}
