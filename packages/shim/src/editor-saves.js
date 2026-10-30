import { contentHash } from "./fs/content-versions.js";

// A per-call token, never an ambient "currently saving" flag: an unrelated plugin
// write must not inherit an editor's version while the adapter queue is waiting.
const editorWrite = Symbol("ignis.editorWrite");
const installed = new WeakMap();
const fail = code => Object.assign(new Error("Saving is paused. Download your changes before reloading."), {code});

export function installEditorSaves(obsidian, app, write, context, recover) {
  const prototype = obsidian?.TextFileView?.prototype, adapter = app?.vault?.adapter;
  if (typeof prototype?.save!=="function" || typeof adapter?.write!=="function" || typeof adapter?.queue!=="function" || typeof adapter?.reconcileInternalFile!=="function") throw new Error("Editor save integration unavailable");
  if (installed.has(adapter)) return installed.get(adapter);
  const views = new WeakMap(), pending = new Map();
  const controller={snapshotPending:()=>{
    const now=context();
    return [...pending.values()].filter(item=>item.scope.vault===now.vault && (!now.sessionId || item.scope.sessionId===now.sessionId))
      .map(({path,data})=>({path,data,encoding:"utf8"}));
  }};
  installed.set(adapter,controller);
  const originalWrite = adapter.write;
  adapter.write = function(path, data, options) {
    const intent = options?.[editorWrite];
    if (!intent) return originalWrite.call(this,path,data,options);
    return this.queue(async () => {
      intent.check();
      await write(path,data,intent.expectedHash,intent.check);
      intent.check();
      // Preserve native Vault.modify's cache callback and file reconciliation.
      options.immediate?.();
      await this.reconcileInternalFile(path);
    });
  };
  function attach(view) {
    if (!(view instanceof obsidian.TextFileView) || views.has(view)) return;
    const state={scope:{...context()},files:new WeakMap(),timer:null};views.set(view,state);
    // Existing views bound the original save in their constructor before module
    // extraction. Replace their debounce too, not just the prototype method.
    view.requestSave=()=>{view.dirty=true;clearTimeout(state.timer);state.timer=setTimeout(()=>{void view.save().catch(()=>{});},2000);};
    view.register?.(()=>clearTimeout(state.timer));
  }
  function sameScope(state) {
    const now=context();
    if(!state.scope.sessionId || now.sessionId!==state.scope.sessionId || now.vault!==state.scope.vault)throw fail("AUTH_CONTEXT_CHANGED");
  }
  // Mirrors TextFileView.save in Obsidian 1.14.4, with an explicit baseline from
  // this view and terminal recovery. Generic Vault.modify/adapter.write stay native.
  prototype.save=async function(clear=false) {
    attach(this);const state=views.get(this);
    clearTimeout(state.timer);this.dirty=false;
    const file=this.file;
    if(!file || file.deleted)return;
    if(!state.files.has(file))state.files.set(file,{blocked:false});
    const record=state.files.get(file);
    if(this.saving){if(!clear)this.saveAgain=true;return;}
    this.saveAgain=false;
    const data=this.getViewData(),previous=this.lastSavedData;
    if(previous===data || previous===null)return;
    const path=file.path;
    const check=()=>{sameScope(state);if(record.blocked)throw fail("CONTENT_CONFLICT");if(this.file!==file || file.deleted || file.path!==path)throw fail("CONTENT_CONFLICT");};
    this.saving=true;
    try {
      check();
      if(typeof previous!=="string" || typeof data!=="string")throw fail("CONTENT_VERSION_REQUIRED");
      // Never clear the editor until the server has acknowledged this version.
      pending.set(record,{path,data,scope:state.scope});
      this.data=data;this.lastSavedData=data;
      await this.app.vault.modify(file,data,{[editorWrite]:{expectedHash:contentHash(previous),check}});
      check();
      pending.delete(record);
      if(clear){this.data=null;this.lastSavedData=null;this.clear();}
    } catch(error) {
      this.lastSavedData=previous;this.dirty=true;record.blocked=true;
      // A lost response may already have published the bytes. No blind retry and
      // no automatic rebase, even if a background read subsequently returns data.
      try {sameScope(state);recover({path,content:data,binary:false,...state.scope,code:error.code});}catch{}
      throw error;
    } finally {
      this.saving=false;
      if(this.saveAgain && !clear && !record.blocked)void this.save().catch(()=>{});
    }
  };
  const originalLoad=prototype.onload;
  prototype.onload=function(...args){attach(this);return originalLoad?.apply(this,args);};
  app.workspace.iterateAllLeaves(leaf=>attach(leaf.view));
  app.workspace.on("layout-change",()=>app.workspace.iterateAllLeaves(leaf=>attach(leaf.view)));
  return controller;
}
