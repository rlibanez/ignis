export function createSharedNotice(currentContext, host=window, ordinary=false) {
  const pending=new Map();let panel,url,recovery,lastMessage,dismissedMessage,scope;
  const placement={position:"fixed",bottom:"20px",right:"20px",zIndex:"10000"};
  function clear(){pending.clear();panel?.remove();recovery?.remove();panel=null;recovery=null;lastMessage=null;dismissedMessage=null;scope=null;if(url)host.URL.revokeObjectURL(url);url=null;}
  function valid(){const current=currentContext();return current?.sessionId && (!scope || (scope.sessionId===current.sessionId && scope.vault===current.vault));}
  host.addEventListener("ignis:auth-lost",clear);
  function download(){
    if(!valid()){clear();return;}
    if(url)host.URL.revokeObjectURL(url);
    url=host.URL.createObjectURL(new host.Blob([JSON.stringify({files:Object.fromEntries(pending)},null,2)],{type:"application/json"}));
    const a=host.document.createElement("a");a.href=url;a.download=ordinary?"ignis-unsaved-changes.json":"ignis-unsaved-shared-changes.json";a.click();
  }
  function dismiss(){
    dismissedMessage=lastMessage;panel?.remove();panel=null;
    if(pending.size && !recovery){
      recovery=host.document.createElement("button");recovery.textContent=ordinary?"Recover unsaved changes":"Recover shared changes";
      recovery.title="Reopen the recovery notice";Object.assign(recovery.style,placement);
      recovery.onclick=()=>{if(!valid()){clear();return;}show(lastMessage,true);};host.document.body.append(recovery);
    }
  }
  function show(message,force=false){
    if(!valid()){clear();return;}
    if(!host.document.body || (!force && dismissedMessage===message))return;
    scope ||= {...currentContext()};lastMessage=message;
    recovery?.remove();recovery=null;
    if(!panel){panel=host.document.createElement("aside");panel.setAttribute("role","alert");panel.setAttribute("aria-label",ordinary?"File recovery":"Shared resources");Object.assign(panel.style,{...placement,maxWidth:"420px",padding:"16px",background:"var(--background-primary,#222)",color:"var(--text-normal,#eee)",border:"1px solid var(--color-orange,#b98b45)",borderRadius:"8px"});host.document.body.append(panel);}
    panel.replaceChildren();
    const close=host.document.createElement("button");close.textContent="×";close.setAttribute("aria-label",ordinary?"Dismiss file recovery notice":"Dismiss shared resource notice");close.title="Dismiss";close.style.float="right";close.onclick=dismiss;panel.append(close);
    const text=host.document.createElement("p");text.textContent=message;panel.append(text);
    if(pending.size){
      const files=host.document.createElement("ul");files.style.maxHeight="120px";files.style.overflow="auto";
      for(const path of pending.keys()){const item=host.document.createElement("li");item.textContent=path;files.append(item);}panel.append(files);
    }
    const actions=host.document.createElement("div");Object.assign(actions.style,{display:"flex",flexDirection:"column",gap:"10px",marginTop:"12px"});panel.append(actions);
    const actionStyle={boxSizing:"border-box",display:"flex",alignItems:"center",justifyContent:"center",width:"100%",height:"auto",minHeight:"36px",margin:"0",padding:"8px 12px",border:"1px solid var(--background-modifier-border,#555)",borderRadius:"6px",background:"var(--interactive-normal,#333)",color:"var(--text-normal,#eee)",font:"inherit",textAlign:"center",textDecoration:"none",whiteSpace:"normal",cursor:"pointer",boxShadow:"none"};
    const link=host.document.createElement("a");link.href=ordinary?"/account":"/shares";link.textContent=ordinary?"Manage account":"Manage shared resources";link.target="_blank";link.rel="noopener";Object.assign(link.style,actionStyle);actions.append(link);
    if(pending.size){const button=host.document.createElement("button");button.textContent=ordinary?"Download recovery copy":"Download shared recovery copy";Object.assign(button.style,actionStyle);button.onclick=download;actions.append(button);}
  }
  function preserve(event,message){
    const context=currentContext();if(!context?.sessionId || context.sessionId!==event.sessionId || context.vault!==event.vault || event.code==="AUTH_CONTEXT_CHANGED")return;
    if(!valid())clear();scope={...context};
    const previous=pending.get(event.path),value={content:event.content,encoding:event.binary?"base64":"utf8"};
    pending.set(event.path,value);show(message,!previous || previous.content!==value.content || previous.encoding!==value.encoding);
  }
  function failure(event){preserve(event,ordinary?"Saving is paused for the files listed below because their content changed or the save could not be confirmed. Download a recovery copy before reloading. Other files are unaffected.":"The shared files listed below could not be saved. Saving is paused only for those files; local notes are unaffected. Download a recovery copy before reloading.");}
  function removed(path,reason){try{host.app?.workspace?.iterateAllLeaves?.(leaf=>{const file=leaf.view?.file?.path;if(file===path && leaf.view?.editor){preserve({path:file,content:leaf.view.editor.getValue(),code:"SHARE_UNAVAILABLE",...currentContext()},reason==="read-only" ? "The shared files listed below are now read-only. A recovery copy of their open editors is retained as a precaution. Download it before reloading. Local notes are unaffected." : "The shared files listed below are no longer available. A recovery copy of their open editors is retained as a precaution. Local notes are unaffected.");}});}catch{}}
  return {show,failure,removed};
}
