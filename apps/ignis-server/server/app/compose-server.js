const path = require('node:path');
const http = require('node:http');
const express = require('express');
const {disposeAll} = require('./dispose');
const {createSecurity} = require('./create-security');
const {readAuthConfig} = require('../auth/http-policy');
const {installRoutes} = require('../integration/ignis/install-routes');
const {connectEvents} = require('../integration/ignis/connect-events');
let active = false;

// Legacy Ignis adapters remain single-instance. Their ownership is explicit here;
// feature services will be extracted in subsequent phases, not hidden in HTTP.
async function composeServer() {
  if (active) throw new Error('Only one default Ignis runtime may be active in a process');
  active = true;
  const disposers = [() => {active=false;}];
  let server, wss, closing, auth, vaultLifecycle;
  const close = () => closing ||= (async () => {
    const errors = [];
    const httpClosed = server ? new Promise((resolve,reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
    }) : Promise.resolve();
    for (const client of wss?.clients || []) client.terminate();
    try { await httpClosed; } catch (error) { errors.push(error); }
    try {await auth?.drain();await vaultLifecycle?.drainRouterWork();} catch (error) {errors.push(error);}
    try { await disposeAll(disposers); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors,'Server cleanup failed');
  })();
  try {
    const config = require('../config');
    const settings = require('../settings');
    const {setupWebSocket,watcher,writeCoalescer} = require('@ignis/server-core');
    const plugins = require('../plugin-system/manager');
    const {BRIDGE_PLUGIN_ID,migratePluginsFromAllVaults} = require('../plugin-system/migrate-bridge');
    vaultLifecycle = require('../vault/lifecycle');
    const bootstrapCache = require('../cache');
    const authConfig = readAuthConfig();
    const repo = path.resolve(__dirname,'../../../..');
    const staticRoots = [{root:path.join(__dirname,'../assets'),mount:'/assets/'},
      path.join(repo,'packages/ui/dist'),path.join(repo,'packages/shim/dist'),config.obsidianAssetsPath];
    auth = createSecurity({dataRoot:config.dataRoot,vaultRoot:config.vaultRoot,config:authConfig,staticRoots,nativeCssPath:path.join(config.obsidianAssetsPath,'app.css')});
    disposers.push(() => auth.close());
    disposers.push(() => writeCoalescer.flushAll());
    disposers.push(() => plugins.shutdownPlugins());
    disposers.push(() => watcher.stopAll());
    writeCoalescer.configure({writeCoalesceMs:settings.get('writeCoalesceMs')});
    watcher.configure({ignoredPaths:settings.resolveIgnoreLines()});
    require('../obsidian-account/ob-cli').init({obHome:path.join(plugins.getPluginDataDir(config.dataRoot,'headless-sync'),'ob-home')});
    config.setVaultDirectoryAvailability(auth.vaultDirectoryAvailable);
    config.setRegisteredVaults(auth.registeredVaults);
    config.refreshVaults();
    disposers.push(() => {config.setVaultDirectoryAvailability(() => false);config.setRegisteredVaults(()=>({}));});
    const app = express();
    auth.install(app);
    installRoutes({app,auth,authConfig,config,settings,writeCoalescer});
    server = http.createServer(app);
    require('../transport/http/upload-timeouts').installUploadTimeouts(server);
    wss = setupWebSocket(server,{getVaultPath:config.getVaultPath,originAllowlist:settings.get('wsOrigins'),security:auth.wsSecurity});
    disposers.push(() => new Promise((resolve,reject) => wss.close(error => error ? reject(error) : resolve())));
    vaultLifecycle.setWss(wss);
    disposers.push(() => vaultLifecycle.setWss(null));
    disposers.push(connectEvents({auth,wss,config,watcher,writeCoalescer,bootstrapCache}));
    return {
      close,
      async start() {
        await auth.initialize();
        require('../static/obsidian-terms').getObsidianTerms();
        await plugins.initPlugins({app,config,wss,watcher});
        const bundled = plugins.getBundledPluginDirs();
        for (const {distDir} of bundled) { auth.staticRoots.push(distDir); app.use(express.static(distDir)); }
        app.use(auth.errorHandler);
        await migratePluginsFromAllVaults(config.vaultRoot,[BRIDGE_PLUGIN_ID,...bundled.map(item=>item.bundledPluginId)],auth.vaultDirectoryAvailable,config.vaults);
        await new Promise((resolve,reject) => {
          const failed = error => {server.off('listening',listening);reject(error);};
          const listening = () => {server.off('error',failed);resolve();};
          server.once('error',failed);server.once('listening',listening);server.listen(config.port);
        });
        void bootstrapCache.warmUp().catch(() => require('@ignis/server-core/src/logger').emit('warn','server.cache.crawl.warmup_failed'));
        return {...server.address(),schemaVersion:auth.schemaVersion};
      },
    };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error,cleanup],'Server composition failed'); }
    throw error;
  }
}
module.exports = {composeServer};
