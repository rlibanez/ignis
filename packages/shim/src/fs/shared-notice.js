import {nativeTooltip} from '../native-tooltip.js';

const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
export function createSharedNotice(currentContext, host=window, ordinary=false) {
  const pending=new Map(),restorers=new Map(),copiers=new Map(),readers=new Map(),messages=new Map(),codes=new Map();let renderedPath,panel,url,recovery,lastMessage,dismissedMessage,scope,permissionDenied=false;
  const placement={position:"fixed",bottom:"20px",right:"20px",zIndex:"var(--layer-popover, 30)"};
  function clear(){permissionDenied=false;pending.clear();restorers.clear();copiers.clear();readers.clear();messages.clear();codes.clear();panel?.remove();recovery?.remove();panel=null;recovery=null;lastMessage=null;dismissedMessage=null;scope=null;if(url)host.URL.revokeObjectURL(url);url=null;}
  function valid(){const current=currentContext();return current?.sessionId && (!scope || (scope.sessionId===current.sessionId && scope.vault===current.vault));}
  const activePath=()=>host.app?.workspace?.getActiveFile?.()?.path;
  const scoped=()=>typeof host.app?.workspace?.getActiveFile==="function";
  const visibleEntries=()=>[...pending].filter(([path])=>!scoped() || path===activePath());
  function setVisible(node,visible){
    if(!node)return;
    node.hidden=!visible;
    // Obsidian themes can override the browser's default [hidden] display rule.
    if(visible)node.style.removeProperty("display");
    else node.style.setProperty("display","none","important");
  }
  function syncVisibility(){
    const path=activePath(),visible=!scoped() || pending.has(path);
    setVisible(panel,visible);
    setVisible(recovery,visible);
    if(visible && panel && renderedPath!==path && messages.has(path))show(messages.get(path),true);
  }
  const workspace=host.app?.workspace;
  const refs=[workspace?.on?.("file-open",syncVisibility),workspace?.on?.("active-leaf-change",syncVisibility)].filter(Boolean);
  host.addEventListener("ignis:auth-lost",()=>{clear();for(const ref of refs)workspace.offref?.(ref);});
  function download(){
    if(!valid()){clear();return;}
    if(url)host.URL.revokeObjectURL(url);
    url=host.URL.createObjectURL(new host.Blob([JSON.stringify({files:Object.fromEntries(pending)},null,2)],{type:"application/json"}));
    const a=host.document.createElement("a");a.href=url;a.download=ordinary?"ignis-unsaved-changes.json":"ignis-unsaved-shared-changes.json";a.click();
  }
  function dismiss(){
    dismissedMessage=lastMessage;panel?.remove();panel=null;
    if(pending.size && !recovery){
      recovery=host.document.createElement("button");recovery.textContent=translateIgnis("Manage changes");
      nativeTooltip(host,recovery,translateIgnis("Manage unsaved changes"));
      Object.assign(recovery.style,{position:"static",order:"-1",margin:"0",padding:"0 6px",height:"auto",minHeight:"0",font:"inherit",color:"var(--text-muted)",background:"transparent",border:"0",boxShadow:"none",cursor:"pointer"});
      recovery.onclick=()=>{if(!valid()){clear();return;}show(lastMessage,true);};setVisible(recovery,!scoped() || pending.has(activePath()));(host.document.querySelector?.(".status-bar") || host.document.body).prepend(recovery);
    }
  }
  function show(message,force=false){
    if(!valid()){clear();return;}
    if(!host.document.body || (!force && dismissedMessage===message))return;
    if(scoped() && pending.size && !pending.has(activePath())){setVisible(panel,false);setVisible(recovery,false);return;}
    if(scoped() && messages.has(activePath())){message=messages.get(activePath());permissionDenied=codes.get(activePath())==="EACCES";}
    if(panel && !force && renderedPath===activePath() && lastMessage===message){setVisible(panel,true);return;}
    scope ||= {...currentContext()};lastMessage=message;renderedPath=activePath();
    recovery?.remove();recovery=null;
    if(!panel){panel=host.document.createElement("aside");panel.setAttribute("role","alert");Object.assign(panel.style,{...placement,maxWidth:"420px",padding:"16px",background:"var(--background-primary,#222)",color:"var(--text-normal,#eee)",border:"1px solid var(--color-orange,#b98b45)",borderRadius:"8px"});host.document.body.append(panel);}
    setVisible(panel,true);panel.replaceChildren();
    const close=host.document.createElement("button");close.textContent="×";nativeTooltip(host,close,translateIgnis("Close"));close.style.float="right";close.onclick=dismiss;panel.append(close);
    const text=host.document.createElement("p");text.textContent=message;panel.append(text);
    if(pending.size){
      const files=host.document.createElement("ul");files.style.maxHeight="120px";files.style.overflow="auto";
      for(const [path] of visibleEntries()){const item=host.document.createElement("li");item.textContent=path;files.append(item);
      }panel.append(files);
    }
    const actions=host.document.createElement("div");Object.assign(actions.style,{display:"flex",flexDirection:"column",gap:"10px",marginTop:"12px"});panel.append(actions);
    const actionStyle={boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",width:"100%",height:"auto",minHeight:"36px",margin:"0",padding:"8px 12px",border:"1px solid var(--background-modifier-border,#555)",borderRadius:"6px",background:"var(--interactive-normal,#333)",color:"var(--text-normal,#eee)",font:"inherit",textAlign:"center",textDecoration:"none",whiteSpace:"normal",cursor:"pointer",boxShadow:"none"};
    if(permissionDenied)for(const [path,value] of visibleEntries()){
      const label=pending.size>1?" — "+path:"";
      if(copiers.has(path)){
        const copy=host.document.createElement("button");copy.textContent=translateIgnis("Save a copy")+label;Object.assign(copy.style,actionStyle);
        copy.onclick=()=>{if(!valid()){clear();return;}try{copiers.get(path)(()=>{if(valid())dismiss();else clear();});}catch{copy.textContent=translateIgnis("The note changed. Try again from its latest recovery notice.");}};actions.append(copy);
      }
      if(value.encoding==="utf8"){
        const note=host.document.createElement("button");note.textContent=translateIgnis("Download note")+label;Object.assign(note.style,actionStyle);
        note.onclick=()=>{if(!valid()){clear();return;}if(url)host.URL.revokeObjectURL(url);let content;try{content=readers.has(path)?readers.get(path)():value.content;}catch{note.textContent=translateIgnis("The note changed. Try again from its latest recovery notice.");return;}url=host.URL.createObjectURL(new host.Blob([content],{type:"text/plain;charset=utf-8"}));const a=host.document.createElement("a");a.href=url;a.download=path.split("/").pop();a.click();};actions.append(note);
      }
    }
    for(const [path] of visibleEntries())if(restorers.has(path)){
      const restore=host.document.createElement("button");restore.textContent=translateIgnis("Show original content");
      if(pending.size>1)restore.textContent+=" — "+path;
      Object.assign(restore.style,actionStyle);
      restore.onclick=()=>{if(!valid()){clear();return;}try{restorers.get(path)();dismiss();}catch{restore.textContent=translateIgnis("The note changed. Try again from its latest recovery notice.");}};
      actions.append(restore);
    }
    const link=host.document.createElement("a");link.href=ordinary?"/account":"/shares";link.textContent=ordinary?translateIgnis("Manage account"):translateIgnis("Manage shared resources");link.target="_blank";link.rel="noopener";Object.assign(link.style,actionStyle);if(!permissionDenied)actions.append(link);
    if(pending.size && (!permissionDenied || [...pending.values()].some(value=>value.encoding!=="utf8"))){const button=host.document.createElement("button");button.textContent=translateIgnis("Download recovery copy");Object.assign(button.style,actionStyle);button.onclick=download;actions.append(button);}
  }
  function preserve(event,message){
    const context=currentContext();if(!context?.sessionId || context.sessionId!==event.sessionId || context.vault!==event.vault || event.code==="AUTH_CONTEXT_CHANGED")return;
    if(!valid())clear();scope={...context};
    const previous=pending.get(event.path),value={content:event.content,encoding:event.binary?"base64":"utf8"};
    if(typeof event.restoreOriginal==="function")restorers.set(event.path,event.restoreOriginal);else restorers.delete(event.path);
    if(typeof event.saveCopy==="function")copiers.set(event.path,event.saveCopy);else copiers.delete(event.path);
    if(typeof event.currentContent==="function")readers.set(event.path,event.currentContent);else readers.delete(event.path);
    messages.set(event.path,message);codes.set(event.path,event.code);
    permissionDenied=event.code==="EACCES";
    Object.defineProperty(value,"recoveryToken",{value:event.recoveryToken});
    pending.set(event.path,value);show(message,!previous || previous.content!==value.content || previous.encoding!==value.encoding);
  }
  function failure(event){
    if(event.resolved){
      const current=currentContext();
      if(!valid() || current.sessionId!==event.sessionId || current.vault!==event.vault || !event.recoveryToken || pending.get(event.path)?.recoveryToken!==event.recoveryToken)return;
      for(const map of [pending,restorers,copiers,readers,messages,codes])map.delete(event.path);
      if(!pending.size)clear();
      else {panel?.remove();panel=null;show(messages.get(activePath()) ?? messages.values().next().value,true);syncVisibility();}
      return;
    }
    preserve(event,event.code==="EACCES"?translateIgnis("You do not have write permission for this file. You can save your changes as a copy in a vault where you have write permission or download the note."):ordinary?translateIgnis("Saving is paused for the files listed below because their content changed or the save could not be confirmed. Download a recovery copy before reloading. Other files are unaffected."):translateIgnis("The shared files listed below could not be saved. Saving is paused only for those files; local notes are unaffected. Download a recovery copy before reloading."));}
  function removed(path,reason){
    try{host.app?.workspace?.iterateAllLeaves?.(leaf=>{
      const view=leaf.view,file=view?.file?.path;
      if(file!==path || !view.editor)return;
      const content=typeof view.getViewData==="function"?view.getViewData():view.editor.getValue();
      // An open editor is not an unsaved editor. Compare its actual text with
      // the native saved baseline; dirty alone can be set by a no-op change.
      if(typeof view.lastSavedData==="string"){
        if(content===view.lastSavedData && !view.saving)return;
      }else if(!view.dirty && !view.saving)return;
      if(reason==="read-only"){
        // The editor save integration retains the draft and supplies the same
        // copy/download/restore actions as any other denied editor write.
        // An in-flight save already owns its recovery and must finish first.
        if(view.saving)return;
        if(typeof view.save==="function"){
          // Wait until the mount update has installed its new Read permission.
          void Promise.resolve().then(()=>{if(view.file?.path===path)return view.save();}).catch(()=>{});return;
        }
        failure({path:file,content,code:"EACCES",...currentContext()});
      }else preserve({path:file,content,code:"SHARE_UNAVAILABLE",...currentContext()},translateIgnis("This shared resource is no longer available. Download your unsaved changes before leaving."));
    });}catch{}
  }
  return {show,failure,removed};
}
