// An uncertain settings write is not retried automatically. Keep a recovery copy
// in this page only; never persist it across account changes.
export function createPrivateConflictNotice(currentContext, host = window) {
  const pending = new Map();
  let panel = null;
  let downloadURL = null;
  let scope = null;
  function current(event) {
    const context = currentContext();
    return context?.sessionId && context.sessionId === event.sessionId && context.vault === event.vault;
  }
  function clear() {
    pending.clear();
    panel?.remove(); panel=null; scope=null;
    if (downloadURL) host.URL.revokeObjectURL(downloadURL);
    downloadURL=null;
  }
  host.addEventListener("ignis:auth-lost",clear);
  return event => {
    if (!current(event) || event.code === "AUTH_CONTEXT_CHANGED") { clear(); return; }
    if (scope && (scope.sessionId !== event.sessionId || scope.vault !== event.vault)) clear();
    scope = {sessionId:event.sessionId,vault:event.vault};
    if (![".obsidian/app.json",".obsidian/appearance.json",".obsidian/workspace.json"].includes(event.path) ||
        typeof event.content !== "string" || new TextEncoder().encode(event.content).length > 1048576) return;
    pending.set(event.path,event.content);
    if (panel) return;
    const document = host.document;
    panel=document.createElement("aside");
    panel.setAttribute("role","alert");
    panel.setAttribute("aria-label","Settings were not saved");
    Object.assign(panel.style,{position:"fixed",bottom:"16px",right:"16px",maxWidth:"420px",zIndex:"10000",padding:"16px",border:"1px solid var(--color-orange, #db9b45)",borderRadius:"8px",background:"var(--background-primary, #202124)",color:"var(--text-normal, #eee)",boxShadow:"0 4px 20px #0008"});
    const title=document.createElement("strong"); title.textContent="Settings were not saved";
    const message=document.createElement("p");
    message.textContent="Another tab may have changed your settings, or the save could not be confirmed. Automatic settings saves are paused for the affected file. Download a recovery copy, make sure your notes are saved, then reload this page before changing settings again.";
    const button=document.createElement("button");button.type="button";button.textContent="Download unsaved settings";
    button.addEventListener("click",()=>{
      if (!scope || !current(scope)) {clear();return;}
      if(downloadURL) host.URL.revokeObjectURL(downloadURL);
      const data=JSON.stringify({vault:scope.vault,files:Object.fromEntries(pending)},null,2);
      downloadURL=host.URL.createObjectURL(new host.Blob([data],{type:"application/json"}));
      const link=document.createElement("a");link.href=downloadURL;link.download="ignis-unsaved-settings.json";link.click();
    });
    panel.append(title,message,button);document.body.append(panel);
  };
}
