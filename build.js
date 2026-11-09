const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const headlessSyncDir = path.join(
  __dirname,
  "apps",
  "ignis-server",
  "server",
  "plugins",
  "headless-sync",
  "obsidian",
);

// Compute version info once and share across per-package builds.
const info = require('./apps/ignis-server/server/version').createBuildInfo();
const {build} = info;
console.log(`[build] ${info.version} · upstream ${info.upstream.version}`);

const buildInfoPath = path.join(
  __dirname,
  "apps",
  "ignis-server",
  "server",
  "build-info.json",
);

fs.writeFileSync(
  buildInfoPath,
  JSON.stringify(info, null, 2),
);

// Used by packages.
process.env.IGNIS_BUILD_RESOLVED = build;
process.env.IGNIS_VERSION_INFO_RESOLVED = JSON.stringify(info);

Promise.all([
  // Build shim-loader.js (delegated to packages/shim)
  require("./packages/shim/build.js"),

  // Build ignis-ui.js (delegated to packages/ui)
  require("./packages/ui/build.js"),

  // Build headless-sync bundled plugin
  esbuild
    .build({
      entryPoints: [path.join(headlessSyncDir, "src", "main.js")],
      bundle: true,
      outfile: path.join(headlessSyncDir, "dist", "ignis-headless-sync.js"),
      format: "cjs",
      platform: "browser",
      target: ["chrome90"],
      external: ["obsidian", "fs"],
      logLevel: "info",
    })
    .then(() => {
      fs.copyFileSync(
        path.join(headlessSyncDir, "styles.css"),
        path.join(headlessSyncDir, "dist", "ignis-headless-sync.css"),
      );
    }),
]).catch(() => process.exit(1));
