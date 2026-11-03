import {resourceActionStyles} from "../../management/src/resource-action-style.js";
import {nativeTooltip} from './native-tooltip.js';

const translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
import {errorBlock} from "./shared-ui.js";
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
// Keep one Shared tab available without revealing it or changing the active view.
export function createSharedViewRestorer(workspace, onError = () => {}) {
  let stopped = false, queued = false;
  return {
    schedule() {
      if (stopped || queued) return;
      queued = true;
      queueMicrotask(async () => {
        try {
          if (stopped) return;
          const found = new Set(workspace.getLeavesOfType("ignis-shared-resources"));
          // Deferred restored tabs are not necessarily returned by getLeavesOfType.
          workspace.iterateAllLeaves?.(leaf => {
            if (leaf.getViewState?.().type === "ignis-shared-resources") found.add(leaf);
          });
          let leaves = [...found];
          const keep = leaves.find(leaf => leaf === workspace.activeLeaf) || leaves[0];
          for (const leaf of leaves) if (leaf !== keep) leaf.detach();
          if (keep) leaves = [keep];
          if (!leaves.length && workspace.getLeftLeaf) {
            const leaf = workspace.getLeftLeaf(false);
            if (leaf) { await leaf.setViewState({type:"ignis-shared-resources",active:false}); leaves = [leaf]; }
          }
          for (const leaf of leaves) {
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
    update(items) {
      restore(); resources = items.filter(item => !item.owned);
      // A saved destination proves that the recipient already handled this resource,
      // even if browser-local acknowledgements were cleared or are unavailable.
      let changed=false;
      for(const item of resources)if(item.destination && !seen.has(item.id)){seen.add(item.id);changed=true;}
      if(changed)try{write(JSON.stringify([...seen]));}catch{/* Presentation state remains usable in memory. */}
    },
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
  let stopped = false;
  const storageKey = "ignis-shared-seen:" + host.__ignisAuth?.userId;
  const unread = createSharedUnread(() => host.localStorage.getItem(storageKey), value => host.localStorage.setItem(storageKey, value));
  const updateBadge = () => {
    const count = unread.pending().length;
    for (const leaf of app.workspace.getLeavesOfType(type)) {
      const tab = leaf.tabHeaderEl;
      if (!tab) continue;
      tab.classList.add("ignis-shared-tab");
      const anchor=tab.querySelector(".workspace-tab-header-inner-icon") || tab;
      anchor.classList.add("ignis-shared-badge-anchor");
      let badge = tab.querySelector(".ignis-shared-badge");
      if (!badge) { badge=element("span");badge.className="ignis-shared-badge";badge.setAttribute("aria-hidden","true");anchor.append(badge); }
      badge.textContent=String(count);badge.hidden=!count;
      nativeTooltip(host,tab,count ? translateIgnis("Shared ({p0} new)",{p0:count}) : translateIgnis("Shared"));
    }
  };
  class SharedView extends obsidian.ItemView {
    getViewType(){return type;}
    getDisplayText(){return translateIgnis("Shared");}
    getIcon(){return "users";}
    async onOpen(){this.closed=false;await this.reload();updateBadge();}
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
      for (const title of this.contentEl.querySelectorAll(".ignis-shared-section:not([hidden]) [data-shared-id]")) this.observer.observe(title);
    }
    async reload(snapshot){
      if(this.loading)return;
      this.loading=true;
      this.observer?.disconnect();
      this.contentEl.replaceChildren();
      this.contentEl.classList.add("ignis-shared-panel");
      const status=element("p",translateIgnis("Loading shared resources…"));status.setAttribute("role","status");
      const header=element("div");header.className="nav-header";
      const toolbar=element("div");toolbar.className="nav-buttons-container";header.append(toolbar);
      this.activeSection ??= "owned";
      const sections=new Map(),buttons=new Map();
      const activate=key=>{
        this.activeSection=key;
        for(const [name,section] of sections)section.hidden=name!==key;
        for(const [name,button] of buttons){
          button.classList.toggle("is-active",name===key);
          button.setAttribute("aria-pressed",String(name===key));
        }
        this.observeUnread();
      };
      for(const [key,text,icon] of [["owned","Shared by me","square-arrow-right-exit"],["received","Shared with me","square-arrow-right-enter"]]){
        const button=element("div");button.className="clickable-icon nav-action-button";
        button.setAttribute("role","button");button.tabIndex=0;
        button.onkeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();activate(key);}};
        obsidian.setIcon(button,icon);nativeTooltip(host,button,translateIgnis(text));
        button.onclick=()=>activate(key);buttons.set(key,button);toolbar.append(button);
      }
      this.contentEl.append(header,status);
      try {
        const data=snapshot ?? await api();
        if (stopped || this.closed) return;
        unread.update(data.resources);updateBadge();
        const pending = new Set(unread.pending());
        this.renderedIds = data.resources.filter(r=>!r.owned).map(r=>r.id);
        status.remove();
        for(const owned of [false,true]) {
          const section=element("div");section.className="ignis-shared-section";
          sections.set(owned?"owned":"received",section);this.contentEl.append(section);
          section.append(element("h4",owned?translateIgnis("Shared by me"):translateIgnis("Shared with me")));
          const resources=data.resources.filter(resource=>resource.owned===owned);
          if(!resources.length)section.append(element("p",translateIgnis("No shared resources.")));
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
              nativeTooltip(host,placement,translateIgnis("Choose a vault and save the location to place this resource."),{help:true});
              Object.assign(placement.style,{display:"inline-block",marginLeft:"8px",padding:"2px 6px",borderRadius:"4px",fontSize:"var(--font-smallest)",fontWeight:"500",color:"var(--text-muted)",backgroundColor:"var(--background-modifier-hover)",verticalAlign:"middle"});
              card.append(placement);
            }
            if(owned){
              card.append(element("p",(data.ownedVaults.find(v=>v.id===resource.vault)?.name || translateIgnis("Vault"))+" / "+resource.path));
              for(const grant of resource.grants)card.append(element("p",grant.login+" · "+(grant.role==="editor"?translateIgnis("Read / Write"):translateIgnis("Read"))));
            }else{
              const vault=data.destinationVaults.find(v=>v.id===resource.destination);
              card.append(element("p",vault ? vault.name+" / "+(resource.localPath || resource.name) : translateIgnis("Not placed — choose a vault")));
              card.append(element("p",resource.owner+" · "+(resource.role==="editor"?translateIgnis("Read / Write"):translateIgnis("Read"))));
            }
            if(resource.available===false)card.append(element("p",translateIgnis("Unavailable")));
            const actions=element("div");actions.className="ignis-shared-actions";card.append(actions);
            const edit=element("button");edit.className="ignis-resource-action";obsidian.setIcon(edit,"pencil");
            edit.setAttribute("aria-label",translateIgnis("Edit"));nativeTooltip(host,edit,translateIgnis("Edit"));actions.append(edit);
            const openResource=(action)=>{
              const session=host.__ignisAuth?.sessionId;
              const check=()=>{if(!session || host.__ignisAuth?.blocked || host.__ignisAuth?.sessionId!==session)throw new Error(translateIgnis("Your session changed. Reload before continuing."));};
              check();host.__ignisOpenResourceSharing({initialResource:{id:resource.id,session,action},assertContext:check,onMutation:async()=>{await sharedFiles.refresh();await this.reload();}});
            };
            edit.onclick=()=>openResource();
            if(owned){
              const remove=element("button");remove.className="ignis-resource-action";obsidian.setIcon(remove,"trash-2");
              remove.setAttribute("aria-label",translateIgnis("Delete"));nativeTooltip(host,remove,translateIgnis("Delete"));
              remove.onclick=()=>openResource("revoke");actions.append(remove);
            }
            section.append(card);
          }
        }
        activate(this.activeSection);
      }catch(error){errorBlock(status);status.textContent=translateIgnis(error.message);}finally{this.loading=false;}
    }
  }
  class SharedPlugin extends obsidian.Plugin {
    onload(){
      const style=element("style");
      style.textContent=resourceActionStyles+`
        .view-content.ignis-shared-panel {
          padding: 12px;
          font-size: var(--font-ui-small);
          line-height: var(--line-height-normal);
        }
        .ignis-shared-section > h4 {
          margin: 16px 0 8px;
          font-size: var(--font-ui-small);
          font-weight: var(--font-semibold);
        }
        .ignis-shared-panel > .nav-header { margin: -12px -12px 0; }
        .workspace-tab-header.ignis-shared-tab,
        .ignis-shared-tab .workspace-tab-header-inner { overflow:visible; }
        .ignis-shared-badge-anchor { position:relative;overflow:visible; }
        .ignis-shared-badge { position:absolute;top:-3px;right:-4px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:16px;height:16px;margin:0;padding:0 4px;background:var(--interactive-accent);color:var(--text-on-accent);border-radius:999px;font-size:10px;font-weight:600;line-height:16px;pointer-events:none;z-index:1; }
        .ignis-shared-badge[hidden] { display:none; }
        .ignis-shared-actions { display:flex;gap:8px;margin-top:12px; }
        .ignis-shared-section[hidden] { display: none; }
        .ignis-shared-panel p { margin: 8px 0; }
        .ignis-shared-panel section p { color: var(--text-muted); }
        .ignis-shared-panel section p:last-child { margin-bottom: 0; }
        .ignis-shared-panel label,
        .ignis-shared-panel input,
        .ignis-shared-panel select,
        .ignis-shared-panel button { font-size: var(--font-ui-small); }
      `;
      host.document.head.append(style);
      this.register(()=>style.remove());
      this.registerView(type,leaf=>new SharedView(leaf));
      this.registerEvent(app.workspace.on("file-menu", (menu, file) => {
        const path = file?.path;
        if (!path || path.split("/").some(part => !part || part.startsWith(".")) || sharedFiles.owns(path) || host.__ignisAuth?.blocked) return;
        const current = host.__vaultList?.find(vault => vault.uuid === host.__currentVaultUuid);
        if (!current || current.membership !== "owner") return;
        menu.addItem(item => item.setTitle(translateIgnis("Share")).setIcon("users")
          .onClick(() => openShareDialog(obsidian, app, file, sharedFiles, host)));
      }));
      const restorer=createSharedViewRestorer(app.workspace,()=>console.warn("[ignis] Unable to restore Shared view"));
      this.register(()=>restorer.stop());
      this.registerEvent(app.workspace.on("layout-change",()=>restorer.schedule()));
      app.workspace.onLayoutReady(()=>{if(!stopped)restorer.schedule();});
      let checking=false,checkPending=false,retryTimer=null,retryDelay=2000;
      const check=async()=>{
        if(stopped || host.document.visibilityState!=="visible")return;
        if(checking){checkPending=true;return;}
        clearTimeout(retryTimer);retryTimer=null;checking=true;
        try {
          const data=await api();retryDelay=2000;if(stopped)return;
          unread.update(data.resources);updateBadge();
          for(const leaf of app.workspace.getLeavesOfType(type)) {
            const view=leaf.view;
            // The panel is informational; resource editors keep their separate drafts.
            if(view.renderedIds) await view.reload(data);
            else view.observeUnread?.();
          }
        } catch {
          // Retry a missed invalidation after an outage, without steady polling.
          if(!stopped){retryTimer=setTimeout(()=>{retryTimer=null;void check();},retryDelay);retryTimer.unref?.();retryDelay=Math.min(30000,retryDelay*2);}
        }
        finally {checking=false;if(checkPending){checkPending=false;void check();}}
      };
      // Refresh on use, rather than polling for notification updates.
      this.registerEvent(app.workspace.on("active-leaf-change",leaf=>{
        if(leaf?.view?.getViewType?.()===type)void leaf.view.reload();
      }));
      const stateChanged=event=>{if(event.detail?.shares)void check();};
      host.addEventListener("ignis:state-changed",stateChanged);
      host.document.addEventListener("visibilitychange",check);
      this.register(()=>{stopped=true;clearTimeout(retryTimer);host.removeEventListener("ignis:state-changed",stateChanged);host.document.removeEventListener("visibilitychange",check);for(const leaf of app.workspace.getLeavesOfType(type))leaf.view.observer?.disconnect();});
      void check();
    }
  }
  const plugin=new SharedPlugin(app,{id:"ignis-shared-panel",name:translateIgnis("Shared"),version:"1.0.0",minAppVersion:"1.0.0",author:"Ignis",description:translateIgnis("Shared resource placement")});
  plugin.load();
  host.addEventListener("ignis:auth-lost",()=>{for(const leaf of app.workspace.getLeavesOfType(type))leaf.detach();plugin.unload();},{once:true});
  return plugin;
}
