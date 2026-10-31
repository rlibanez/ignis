
const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import {addFieldHelp, errorBlock} from "./shared-ui.js";
import { openShareDialog } from "./share-dialog.js";

// The panel changes only the recipient's placement preference, never share grants.
export function createSharedPanelApi(currentContext, request = fetch) {
  const session = currentContext();
  const check = () => { if (!session || currentContext() !== session) throw new Error(translateIgnis("Your session changed. Reload before continuing.")); };
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
    if (!response.ok) throw new Error(translateIgnis(data.error) || translateIgnis("Shared resources unavailable"));
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

// Seen state is presentation-only; authorization always comes from the catalog.
export function createSharedUnread(read, write) {
  let resources = [], seen = new Set();
  const restore = () => { try { const value = JSON.parse(read() || "[]"); if (Array.isArray(value)) for (const id of value) if (typeof id === "string") seen.add(id); } catch {} };
  restore();
  return {
    update(items) { restore(); resources = items.filter(item => !item.owned); },
    pending() { return resources.filter(item => !seen.has(item.id)).map(item => item.id); },
    mark(id) {
      if (!resources.some(item => item.id === id)) return;
      restore(); seen.add(id);
      try { write(JSON.stringify([...seen])); } catch { /* Keep working when browser storage is unavailable. */ }
    },
  };
}

export function installSharedPanel(obsidian, app, sharedFiles, host = window) {
  const type = "ignis-shared-resources";
  const api = createSharedPanelApi(() => host.__ignisAuth?.blocked ? null : host.__ignisAuth?.sessionId);
  const element = (tag, text) => {const el=host.document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  let stopped = false, ribbon, badge;
  const storageKey = "ignis-shared-seen:" + host.__ignisAuth?.userId;
  const unread = createSharedUnread(() => host.localStorage.getItem(storageKey), value => host.localStorage.setItem(storageKey, value));
  const updateBadge = () => {
    if (!badge) return;
    const count = unread.pending().length;
    badge.textContent = String(count); badge.hidden = !count;
    ribbon.setAttribute("aria-label", count ? translateIgnis("Shared ({p0} new)", {p0: (count)}) : translateIgnis("Shared"));
  };
  class SharedView extends obsidian.ItemView {
    getViewType(){return type;}
    getDisplayText(){return translateIgnis("Shared");}
    getIcon(){return "users";}
    async onOpen(){this.closed=false;await this.reload();}
    async onClose(){this.closed=true;this.observer?.disconnect();}
    observeUnread() {
      if (host.document.visibilityState !== "visible" || this.closed || stopped) return;
      this.observer?.disconnect();
      this.observer = new host.IntersectionObserver(entries => {
        if (host.document.visibilityState !== "visible" || this.closed || stopped) return;
        for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          unread.mark(entry.target.dataset.sharedId);
          this.observer.unobserve(entry.target);
        }
        updateBadge();
      }, {threshold: 0.5});
      for (const title of this.contentEl.querySelectorAll("[data-shared-id]")) this.observer.observe(title);
    }
    async reload(){
      if(this.loading)return;
      this.loading=true;
      this.observer?.disconnect();
      this.contentEl.replaceChildren();
      this.contentEl.style.padding="16px";
      const heading=element("h3",translateIgnis("Shared")),status=element("p",translateIgnis("Loading shared resources…"));status.setAttribute("role","status");
      this.contentEl.append(heading,status);
      try {
        const data=await api();
        if (stopped || this.closed) return;
        unread.update(data.resources);updateBadge();
        const pending = new Set(unread.pending());
        this.renderedIds = data.resources.filter(r=>!r.owned).map(r=>r.id);
        status.textContent="";
        const toolbar=element("div");toolbar.style.display="flex";toolbar.style.gap="8px";
        const refresh=element("button",translateIgnis("Refresh"));refresh.onclick=()=>this.reload();
        const manage=element("button",translateIgnis("Manage sharing"));manage.onclick=()=>{if(host.matchMedia("(display-mode: standalone)").matches || host.navigator.standalone===true)host.location.assign("/shares");else host.open("/shares","_blank","noopener");};
        toolbar.append(refresh,manage);this.contentEl.append(toolbar);
        for(const owned of [false,true]) {
          this.contentEl.append(element("h4",owned?translateIgnis("Shared from my vaults"):translateIgnis("Shared with me")));
          const resources=data.resources.filter(resource=>resource.owned===owned);
          if(!resources.length)this.contentEl.append(element("p",translateIgnis("No shared resources.")));
          for(const resource of resources){
            const card=element("section");Object.assign(card.style,{border:"1px solid var(--background-modifier-border)",borderRadius:"8px",padding:"12px",marginBottom:"12px"});
            const title=element("strong",resource.name);card.append(title);
            if (!owned && pending.has(resource.id)) {
              title.dataset.sharedId=resource.id;
              card.style.borderColor="var(--interactive-accent)";
              const label=element("span",translateIgnis("New"));Object.assign(label.style,{color:"var(--text-accent)",marginLeft:"8px",fontSize:"var(--font-smallest)"});card.append(label);
            }
            if (!owned && !resource.destination) {
              // Placement is independent of unread state: keep the purple border for new items.
              card.style.backgroundColor="var(--background-secondary)";
              const placement=element("span",translateIgnis("Not placed"));
              placement.title=translateIgnis("Choose a vault and save the location to place this resource.");
              Object.assign(placement.style,{display:"inline-block",marginLeft:"8px",padding:"2px 6px",borderRadius:"4px",fontSize:"var(--font-smallest)",fontWeight:"500",color:"var(--text-muted)",backgroundColor:"var(--background-modifier-hover)",verticalAlign:"middle"});
              card.append(placement);
            }
            if(owned){
              card.append(element("p",(data.ownedVaults.find(v=>v.id===resource.vault)?.name || translateIgnis("Vault"))+" / "+resource.path));
              card.append(element("p",resource.available?translateIgnis("Available"):translateIgnis("Unavailable")));
              for(const grant of resource.grants)card.append(element("p",grant.login+" · "+(grant.role==="editor"?translateIgnis("Read / Write"):translateIgnis("Read"))));
            }else{
              card.append(element("p",resource.owner+" · "+(resource.role==="editor"?translateIgnis("Read / Write"):translateIgnis("Read"))));
              const label=element("label",translateIgnis("Show in vault")),select=element("select");select.style.width="100%";select.style.marginTop="8px";
              const none=element("option",translateIgnis("Not placed — choose a vault"));none.value="";select.append(none);
              for(const vault of data.destinationVaults){const option=element("option",vault.name);option.value=vault.id;select.append(option);}
              select.value=resource.destination || "";label.append(select);card.append(label);
              const folderLabel=element("label",translateIgnis("Local path")),folder=element("input");folder.type="text";folder.value=resource.localPath || resource.name;folder.placeholder=translateIgnis("Folder/local name");addFieldHelp(host,folderLabel,translateIgnis("Choose a local name, optionally inside an existing folder. This does not rename the original."));
              Object.assign(folderLabel.style,{display:"block",marginTop:"12px"});Object.assign(folder.style,{width:"100%",marginTop:"6px"});folderLabel.append(folder);card.append(folderLabel);
              const save=element("button",translateIgnis("Save location"));save.style.marginTop="12px";card.append(save);
              const error=errorBlock(element("p"));card.append(error);
              save.onclick=async()=>{save.disabled=true;error.textContent="";try{
                await api({id:resource.id,vault:select.value || null,localPath:folder.value});await sharedFiles.refresh();await this.reload();
              }catch(e){error.textContent=translateIgnis(e.message);}finally{save.disabled=false;}};
            }
            this.contentEl.append(card);
          }
        }
        this.observeUnread();
      }catch(error){errorBlock(status);status.textContent=translateIgnis(error.message);}finally{this.loading=false;}
    }
  }
  class SharedPlugin extends obsidian.Plugin {
    onload(){
      this.registerView(type,leaf=>new SharedView(leaf));
      this.registerEvent(app.workspace.on("file-menu", (menu, file) => {
        const path = file?.path;
        if (!path || path.split("/").some(part => !part || part.startsWith(".")) || sharedFiles.owns(path) || host.__ignisAuth?.blocked) return;
        const current = host.__vaultList?.find(vault => vault.uuid === host.__currentVaultUuid);
        if (!current || current.membership !== "owner") return;
        menu.addItem(item => item.setTitle(translateIgnis("Share…")).setIcon("share-2")
          .onClick(() => openShareDialog(obsidian, app, file, sharedFiles, host)));
      }));
      const restorer=createSharedViewRestorer(app.workspace,()=>console.warn("[ignis] Unable to restore Shared view"));
      this.register(()=>restorer.stop());
      this.registerEvent(app.workspace.on("layout-change",()=>restorer.schedule()));
      restorer.schedule();
      ribbon=this.addRibbonIcon("users",translateIgnis("Shared"),async()=>{
        let leaf=app.workspace.getLeavesOfType(type)[0];
        if(!leaf){leaf=app.workspace.getLeftLeaf(false);if(!leaf)return;await leaf.setViewState({type,active:true});}
        await leaf.loadIfDeferred();
        await app.workspace.revealLeaf(leaf);
        await leaf.view.reload();
      });
      ribbon.style.position="relative";
      badge=element("span");badge.hidden=true;badge.setAttribute("aria-hidden","true");
      Object.assign(badge.style,{position:"absolute",top:"-4px",right:"-6px",background:"var(--interactive-accent)",color:"var(--text-on-accent)",borderRadius:"10px",padding:"0 4px",fontSize:"10px",lineHeight:"16px",pointerEvents:"none"});ribbon.append(badge);
      let checking=false;
      const check=async()=>{
        if(stopped || checking || host.document.visibilityState!=="visible")return;
        checking=true;
        try {
          const data=await api();if(stopped)return;
          unread.update(data.resources);updateBadge();
          for(const leaf of app.workspace.getLeavesOfType(type)) {
            const view=leaf.view;
            const ids=data.resources.filter(r=>!r.owned).map(r=>r.id);
            // Avoid resetting placement inputs on each poll.
            if(view.renderedIds && ids.some(id=>!view.renderedIds.includes(id)) && !view.contentEl.contains(host.document.activeElement)) await view.reload();
            else view.observeUnread?.();
          }
        } catch { /* Preserve unread state during connection failures. */ }
        finally {checking=false;}
      };
      const interval=host.setInterval(check,60000);
      host.document.addEventListener("visibilitychange",check);
      this.register(()=>{stopped=true;host.clearInterval(interval);host.document.removeEventListener("visibilitychange",check);for(const leaf of app.workspace.getLeavesOfType(type))leaf.view.observer?.disconnect();});
      void check();
    }
  }
  const plugin=new SharedPlugin(app,{id:"ignis-shared-panel",name:translateIgnis("Shared"),version:"1.0.0",minAppVersion:"1.0.0",author:"Ignis",description:translateIgnis("Shared resource placement")});
  plugin.load();
  host.addEventListener("ignis:auth-lost",()=>{for(const leaf of app.workspace.getLeavesOfType(type))leaf.detach();plugin.unload();},{once:true});
  return plugin;
}
