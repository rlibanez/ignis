// The panel changes only the recipient's placement preference, never share grants.
export function createSharedPanelApi(currentContext, request = fetch) {
  const session = currentContext();
  const check = () => { if (!session || currentContext() !== session) throw new Error("Your session changed. Reload before continuing."); };
  return async (input) => {
    check();
    const response = await request("/api/shares", {
      method: input ? "POST" : "GET", cache: "no-store",
      headers: {"X-Ignis-Context":session, ...(input ? {"Content-Type":"application/json"} : {})},
      ...(input ? {body:JSON.stringify({operation:"destination",input})} : {}),
    });
    check();
    const data = await response.json();
    check();
    if (!response.ok) throw new Error(data.error || "Shared resources unavailable");
    return data;
  };
}

// Hidden restored leaves may retain UnknownView metadata in a DeferredView.
// Materialize only Shared leaves, without revealing them or replacing their state.
export function createSharedViewRestorer(workspace, onError = () => {}) {
  let stopped = false, queued = false;
  return {
    schedule() {
      if (stopped || queued) return;
      queued = true;
      queueMicrotask(async () => {
        try {
          if (stopped) return;
          for (const leaf of workspace.getLeavesOfType("ignis-shared-resources")) {
            if (stopped) break;
            if (leaf.isDeferred) await leaf.loadIfDeferred();
          }
        } catch (error) { if (!stopped) onError(error); }
        finally { queued = false; }
      });
    },
    stop() { stopped = true; },
  };
}

export function installSharedPanel(obsidian, app, sharedFiles, host = window) {
  const type = "ignis-shared-resources";
  const api = createSharedPanelApi(() => host.__ignisAuth?.blocked ? null : host.__ignisAuth?.sessionId);
  const element = (tag, text) => {const el=host.document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  class SharedView extends obsidian.ItemView {
    getViewType(){return type;}
    getDisplayText(){return "Shared";}
    getIcon(){return "users";}
    async onOpen(){await this.reload();}
    async reload(){
      if(this.loading)return;
      this.loading=true;
      this.contentEl.replaceChildren();
      this.contentEl.style.padding="16px";
      const heading=element("h3","Shared"),status=element("p","Loading shared resources…");status.setAttribute("role","status");
      this.contentEl.append(heading,status);
      try {
        const data=await api();status.textContent="";
        const toolbar=element("div");toolbar.style.display="flex";toolbar.style.gap="8px";
        const refresh=element("button","Refresh");refresh.onclick=()=>this.reload();
        const manage=element("button","Manage sharing");manage.onclick=()=>host.open("/shares","_blank","noopener");
        toolbar.append(refresh,manage);this.contentEl.append(toolbar);
        for(const owned of [false,true]) {
          this.contentEl.append(element("h4",owned?"Shared by me":"Shared with me"));
          const resources=data.resources.filter(resource=>resource.owned===owned);
          if(!resources.length)this.contentEl.append(element("p","No shared resources."));
          for(const resource of resources){
            const card=element("section");Object.assign(card.style,{border:"1px solid var(--background-modifier-border)",borderRadius:"8px",padding:"12px",marginBottom:"12px"});
            card.append(element("strong",resource.name));
            if(owned){
              card.append(element("p",(data.ownedVaults.find(v=>v.id===resource.vault)?.name || "Vault")+" / "+resource.path));
              card.append(element("p",resource.available?"Available":"Unavailable"));
              for(const grant of resource.grants)card.append(element("p",grant.login+" · "+(grant.role==="editor"?"Read / Write":"Read")));
            }else{
              card.append(element("p",resource.owner+" · "+(resource.role==="editor"?"Read / Write":"Read")));
              const label=element("label","Show in vault"),select=element("select");select.style.width="100%";select.style.marginTop="8px";
              const none=element("option","Not placed — choose a vault");none.value="";select.append(none);
              for(const vault of data.destinationVaults){const option=element("option",vault.name);option.value=vault.id;select.append(option);}
              select.value=resource.destination || "";label.append(select);card.append(label);
              const folderLabel=element("label","Local path"),folder=element("input");folder.type="text";folder.value=resource.localPath || resource.name;folder.placeholder="Folder/local name";folderLabel.title="Choose a local name, optionally inside an existing folder. This does not rename the original.";
              Object.assign(folderLabel.style,{display:"block",marginTop:"12px"});Object.assign(folder.style,{width:"100%",marginTop:"6px"});folderLabel.append(folder);card.append(folderLabel);
              const save=element("button","Save location");save.style.marginTop="12px";card.append(save);
              const error=element("p");error.setAttribute("role","alert");error.style.color="var(--text-error)";card.append(error);
              save.onclick=async()=>{save.disabled=true;error.textContent="";try{
                await api({id:resource.id,vault:select.value || null,localPath:folder.value});await sharedFiles.refresh();await this.reload();
              }catch(e){error.textContent=e.message;}finally{save.disabled=false;}};
            }
            this.contentEl.append(card);
          }
        }
      }catch(error){status.textContent=error.message;}finally{this.loading=false;}
    }
  }
  class SharedPlugin extends obsidian.Plugin {
    onload(){
      this.registerView(type,leaf=>new SharedView(leaf));
      const restorer=createSharedViewRestorer(app.workspace,()=>console.warn("[ignis] Unable to restore Shared view"));
      this.register(()=>restorer.stop());
      this.registerEvent(app.workspace.on("layout-change",()=>restorer.schedule()));
      restorer.schedule();
      this.addRibbonIcon("users","Shared",async()=>{
        let leaf=app.workspace.getLeavesOfType(type)[0];
        if(!leaf){leaf=app.workspace.getLeftLeaf(false);if(!leaf)return;await leaf.setViewState({type,active:true});}
        await leaf.loadIfDeferred();
        await app.workspace.revealLeaf(leaf);
      });
    }
  }
  const plugin=new SharedPlugin(app,{id:"ignis-shared-panel",name:"Shared",version:"1.0.0",minAppVersion:"1.0.0",author:"Ignis",description:"Shared resource placement"});
  plugin.load();
  host.addEventListener("ignis:auth-lost",()=>{for(const leaf of app.workspace.getLeavesOfType(type))leaf.detach();plugin.unload();},{once:true});
  return plugin;
}
