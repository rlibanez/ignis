export function createSharedNotice(currentContext, host=window) {
  const pending=new Map();let panel,url;
  function clear(){pending.clear();panel?.remove();panel=null;if(url)host.URL.revokeObjectURL(url);url=null;}
  host.addEventListener("ignis:auth-lost",clear);
  function show(message){
    if(!host.document.body)return;
    if(!panel){panel=host.document.createElement("aside");panel.setAttribute("role","alert");panel.setAttribute("aria-label","Shared resources");Object.assign(panel.style,{position:"fixed",bottom:"20px",right:"20px",maxWidth:"420px",padding:"16px",zIndex:"10000",background:"var(--background-primary,#222)",color:"var(--text-normal,#eee)",border:"1px solid var(--color-orange,#b98b45)",borderRadius:"8px"});host.document.body.append(panel);}
    panel.replaceChildren();const text=host.document.createElement("p");text.textContent=message;panel.append(text);
    const link=host.document.createElement("a");link.href="/shares";link.textContent="Manage shared resources";link.target="_blank";link.rel="noopener";panel.append(link);
    if(pending.size){const download=host.document.createElement("button");download.textContent="Download unsaved shared changes";download.style.display="block";download.style.marginTop="12px";download.onclick=()=>{const context=currentContext();if(!context?.sessionId){clear();return;}if(url)host.URL.revokeObjectURL(url);url=host.URL.createObjectURL(new host.Blob([JSON.stringify({files:Object.fromEntries(pending)},null,2)],{type:"application/json"}));const a=host.document.createElement("a");a.href=url;a.download="ignis-unsaved-shared-changes.json";a.click();};panel.append(download);}
  }
  function failure(event){const context=currentContext();if(!context?.sessionId || context.sessionId!==event.sessionId || context.vault!==event.vault || event.code==="AUTH_CONTEXT_CHANGED")return;
    pending.set(event.path,{content:event.content,encoding:event.binary?"base64":"utf8"});show("A shared file could not be saved. Saving is paused for that file. Download your changes, check access and reload before continuing.");}
  function removed(path){try{host.app?.workspace?.iterateAllLeaves?.(leaf=>{const file=leaf.view?.file?.path;if(file===path && leaf.view?.editor){failure({path:file,content:leaf.view.editor.getValue(),code:"SHARE_UNAVAILABLE",...currentContext()});}});}catch{}}
  return {show,failure,removed};
}
