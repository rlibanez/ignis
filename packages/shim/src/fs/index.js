import { contentHash } from "./content-versions.js";
import { createSharedFiles } from "./shared-files.js";
import { createSharedNotice } from "./shared-notice.js";
import { createPrivateConflictNotice } from "./private-conflict-notice.js";
import { createPrivateRuntime } from "./private-runtime.js";
import { MetadataCache } from "./metadata-cache.js";
import { ContentCache } from "./content-cache.js";
import { transport } from "./transport.js";
import { createFsPromises } from "./promises.js";
import { createFsSync } from "./sync.js";
import { createFsWatch } from "./watch.js";
import { createWatcherClient } from "./watcher-client.js";
import { createFdOps } from "./fd.js";
import { createFsCallbacks } from "./callback.js";
import { realpath, realpathSync } from "./realpath.js";
import { constants } from "./constants.js";
import {
  registerReadTransform,
  removeReadTransform,
  resolvePath,
} from "./transforms.js";
import { enqueue, flushPending, hasUnconfirmedWrite } from "./write-coalescer.js";
import { wsClient } from "../ws-client.js";

const privateContext = () => ({
  sessionId: window.__ignisAuth?.blocked ? null : window.__ignisAuth?.sessionId,
  vault: window.__currentVaultUuid,
});
let privateNotice;
const privateRuntime = createPrivateRuntime(privateContext, undefined, event => {
  privateNotice ||= createPrivateConflictNotice(privateContext);
  privateNotice(event);
});
const privateGateway = privateRuntime.gateway;
const metadataCache = new MetadataCache();
const contentCache = new ContentCache();

contentCache.retainWhile(hasUnconfirmedWrite);

const fsWatch = createFsWatch(transport);
let editorNotice;
let sharedNotice;
const notice=()=>sharedNotice ||= createSharedNotice(privateContext);
const sharedFiles=createSharedFiles({metadataCache,watch:fsWatch,currentContext:privateContext,onFailure:event=>notice().failure(event),onNotice:message=>notice().show(message),onRemoved:(path,reason)=>notice().removed(path,reason)});
if(typeof window !== "undefined")window.addEventListener?.("ignis:auth-lost",()=>sharedFiles.stop());
const privateFiles=new Proxy(privateGateway,{get(target,name){
  if(name==="allowsSharedPrefetch")return path=>!sharedFiles.owns(path) && target.allowsSharedPrefetch(path);
  if(name==="assertOrdinary")return (path,resolved)=>{sharedFiles.assertOrdinary(path,resolved);return target.assertOrdinary(path,resolved);};
  return target[name];
}});
const fsPromises = sharedFiles.wrap(createFsPromises(metadataCache, contentCache, transport, privateFiles));
const fsSync = sharedFiles.wrap(createFsSync(metadataCache, contentCache, transport, privateFiles),true);
const watcherClient = createWatcherClient(
  metadataCache,
  contentCache,
  fsWatch,
  wsClient,
  transport,
  privateFiles,
);
const fdOps = createFdOps(metadataCache, contentCache, transport, privateFiles);
const fsCallbacks = createFsCallbacks(fsPromises);

export const fsShim = {
  promises: fsPromises,

  ...fsCallbacks,

  existsSync: fsSync.existsSync,
  readFileSync: fsSync.readFileSync,
  writeFileSync: fsSync.writeFileSync,
  unlinkSync: fsSync.unlinkSync,
  accessSync: fsSync.accessSync,
  statSync: fsSync.statSync,
  readdirSync: fsSync.readdirSync,
  lstatSync: fsSync.lstatSync,
  mkdirSync: fsSync.mkdirSync,
  rmdirSync: fsSync.rmdirSync,
  rmSync: fsSync.rmSync,
  renameSync: fsSync.renameSync,
  copyFileSync: fsSync.copyFileSync,
  appendFileSync: fsSync.appendFileSync,
  utimesSync: fsSync.utimesSync,
  lutimesSync: fsSync.lutimesSync,
  chmodSync: fsSync.chmodSync,

  realpath,
  realpathSync,

  open: fdOps.open,
  openSync: fdOps.openSync,
  read: fdOps.read,
  readSync: fdOps.readSync,
  close: fdOps.close,
  closeSync: fdOps.closeSync,
  fstat: fdOps.fstat,
  fstatSync: fdOps.fstatSync,
  futimes: fdOps.futimes,
  futimesSync: fdOps.futimesSync,

  watch: fsWatch.watch,
  constants,

  invalidate(path) {
    contentCache.invalidate(resolvePath(path));
  },

  _configurePrivateFiles: bootstrap => sharedFiles.configure(privateRuntime.configure(bootstrap)),
  _sharedFiles: sharedFiles,
  _editorContext: privateContext,
  _recoverEditor: event => {editorNotice ||= createSharedNotice(privateContext,window,true);editorNotice.failure(event);},
  async _writeEditorFile(path,content,expectedHash,check) {
    const resolved=resolvePath(path);
    // Do not silently redirect a versioned edit into configuration/private state.
    if(resolved!==path || path.split("/").some(part=>!part || part.startsWith(".")))
      throw Object.assign(new Error("Unsupported editor path"),{code:"CONTENT_CONFLICT"});
    flushPending(resolved);
    return enqueue(resolved,async()=>{
      check();
      try {
        const result=sharedFiles.owns(path)
          ? await sharedFiles.writeEditor(path,content,expectedHash)
          : await transport.writeEditorFile(path,content,expectedHash);
        check();
        if(result?.etag!==contentHash(content))throw Object.assign(new Error("Unconfirmed editor save"),{code:"CONTENT_WRITE_UNCERTAIN"});
        if(!sharedFiles.owns(path)) {
          contentCache.set(resolved,content);
          metadataCache.set(resolved,{type:"file",size:result.size,mtime:result.mtime,ctime:metadataCache.get(resolved)?.ctime || result.mtime});
        }
        return result;
      } catch(error) {contentCache.invalidate(resolved);throw error;}
    });
  },
  _privateFiles: privateFiles,
  _metadataCache: metadataCache,
  _contentCache: contentCache,
  _watcherClient: watcherClient,
  _registerReadTransform: registerReadTransform,
  _removeReadTransform: removeReadTransform,
};
