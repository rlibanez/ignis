import resourceTree from "./resource-tree.cjs";
export function mountShares(scope) {
  const {root, window, location, fetch, channel: openChannel, listen, onDispose, decorate} = scope;
  const document = root.ownerDocument;
  const byId = id => root.querySelector(`#${CSS.escape(id)}`);
var translateIgnis = (message, values = {}) => globalThis.IgnisI18n?.t(message, values) ?? message.replace(/\{(p\d+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

  const $=id=>byId(id);
  let context, catalog, managed, draft, placed, busy=false, locked=false, selectedPath="", pickerGeneration=0;
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  function lock(){locked=true;for(const dialog of root.querySelectorAll("dialog"))dialog.close();$("workspace").hidden=true;$("status").textContent=translateIgnis("Your session has ended or changed. Return to Account to sign in again.");}
  async function api(operation,input){
    if(locked)throw new Error(translateIgnis("Session unavailable"));
    const headers={"X-Ignis-Context":context};
    if(operation){const response=await fetch("/api/auth/csrf",{credentials:"same-origin",cache:"no-store",headers});if(!response.ok)throw new Error(translateIgnis("Unable to check your session."));headers["X-Ignis-Csrf"]=(await response.json()).csrfToken;headers["Content-Type"]="application/json";}
    const response=await fetch("/api/shares",{method:operation?"POST":"GET",credentials:"same-origin",cache:"no-store",headers,...(operation?{body:JSON.stringify({operation,input})}:{})});
    if(response.status===401 || response.headers.get("content-type")?.includes("text/html")){lock();throw new Error(translateIgnis("Session unavailable"));}
    const data=await response.json();scope.assertContext?.();if(locked)throw new Error(translateIgnis("Session unavailable"));if(!response.ok){if(data.code==="AUTH_CONTEXT_CHANGED")lock();throw new Error(translateIgnis(data.error) || translateIgnis("Request failed"));}if(operation && !["browse","validateGrant"].includes(operation))await scope.onMutation?.();return data;
  }
  function confirmAction(title, message, action, opened) {
    return new Promise(resolve => {
      const dialog=node("dialog");dialog.className="ignis-confirm";
      const heading=node("h2",title),description=node("p",message),actions=node("div");actions.className="dialog-actions";
      dialog.setAttribute("aria-label",title);
      const cancel=button(translateIgnis("Cancel"),()=>dialog.close(),false),accept=button(action,()=>dialog.close("confirmed"),false);
      cancel.className="account-button secondary";accept.className="account-button danger";
      const close=iconButton(translateIgnis("Close"),["M18 6 6 18","m6 6 12 12"],()=>dialog.close());
      close.className="share-dialog-close";
      actions.append(cancel,accept);dialog.append(close,heading,description,actions);root.append(dialog);
      dialog.addEventListener("close",()=>{const accepted=dialog.returnValue==="confirmed" && !locked;dialog.remove();resolve(accepted);},{once:true});
      decorate(dialog);dialog.showModal();opened?.(dialog);cancel.focus();
    });
  }
  async function run(fn,dialog){if(busy||locked)return;busy=true;const status=dialog?dialog.querySelector(".error"):$("status");status.textContent="";try{await fn();}catch(error){
    if(dialog?.open && ["grant-dialog","create-dialog"].includes(dialog.id)){
      const field=$(dialog.id==="grant-dialog"?"grant-login":"recipient");field.setCustomValidity(error.message);field.reportValidity();
    }else (dialog && !dialog.open ? $("status") : status).textContent=error.message;
  }finally{busy=false;if(externalRefresh)setTimeout(refreshExternal,0);}}
  const button=(text,action,secondary=true)=>{const el=node("button",text);el.type="button";if(secondary)el.className="secondary table-action";el.onclick=action;return el;};
  function iconButton(label,paths,action){
    const el=button("",action);el.className="icon-button ignis-resource-action";el.title=label;el.setAttribute("aria-label",label);
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    for(const [key,value] of Object.entries({viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"1.7","stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true"}))svg.setAttribute(key,value);
    for(const d of paths){const path=document.createElementNS(svg.namespaceURI,"path");path.setAttribute("d",d);svg.append(path);}
    el.append(svg);return el;
  }
  function table(headers,rows){const wrap=node("div");wrap.className="table-scroll";const el=node("table"),head=node("tr");el.className="responsive-table";el.setAttribute("role","table");for(const name of headers)head.append(node("th",name));const thead=node("thead");thead.append(head);el.append(thead);const body=node("tbody");for(const cells of rows){const row=node("tr");for(const [index,value] of cells.entries()){const cell=node("td");cell.dataset.label=headers[index];cell.append(typeof value==="string"?document.createTextNode(value):value);row.append(cell);}body.append(row);}el.append(body);wrap.append(el);return wrap;}
  function render(){
    for(const [id,owned] of [["received",false],["owned",true]]){
      const resources=catalog.resources.filter(r=>r.owned===owned);
      const rows=resources.map(resource=>{
        const title=node("div",resource.name);
        if(!owned){
          const vault=catalog.destinationVaults.find(v=>v.id===resource.destination);
          const detail=node("span",vault?`${vault.name} / ${resource.localPath || resource.name}`:translateIgnis("Not placed — choose a vault"));
          detail.className="resource-detail";title.append(detail);
        }
        if(owned && !resource.available){const state=node("span",translateIgnis("Unavailable"));state.className="resource-detail";title.append(state);}
        const actions=node("div");actions.className="toolbar";
        if(owned){
          actions.append(iconButton(translateIgnis("Edit"),["M12 20h9","M16 4l4 4-12 12H4v-4Z"],()=>manage(resource)),
            iconButton(translateIgnis("Delete"),["M3 6h18","M9 6V4h6v2","M5 6l1 14h12l1-14","M10 10v6","M14 10v6"],()=>run(async()=>{
              if(!await confirmAction(translateIgnis("Stop sharing"),translateIgnis("Stop sharing “{p0}” with all recipients?",{p0:resource.name}),translateIgnis("Stop sharing")))return;
              await api("revoke",{action:"revoke",id:resource.id,revision:resource.revision});await reload();
            })));
        }else actions.append(button(translateIgnis("Location"),()=>locationDialog(resource)));
        return [title,resource.kind==="directory"?translateIgnis("Folder"):translateIgnis("File"),owned?(catalog.ownedVaults.find(v=>v.id===resource.vault)?.name || translateIgnis("Vault"))+" / "+resource.path:resource.owner,...(owned?[]:[resource.available?(resource.role==="editor"?translateIgnis("Read / Write"):translateIgnis("Read")):translateIgnis("Unavailable")]),actions];
      });
      $(id).replaceChildren(rows.length?table([translateIgnis("Resource"),translateIgnis("Type"),owned?translateIgnis("Path"):translateIgnis("Owner"),...(owned?[]:[translateIgnis("Access")]),translateIgnis("Actions")],rows):node("p",translateIgnis("No shared resources.")));
    }
    $("new-share").disabled=!catalog.ownedVaults.length;
  }
  async function reload(){catalog=await api();render();}
  function locationDialog(resource){
    placed=resource;$("location-heading").textContent=translateIgnis("Resource location")+" "+resource.name;
    const select=$("destination-vault");const none=node("option",translateIgnis("Not placed — choose a vault"));none.value="";
    select.replaceChildren(none,...catalog.destinationVaults.map(v=>{const option=node("option",v.name);option.value=v.id;return option;}));
    select.value=resource.destination || (catalog.destinationVaults.length===1?catalog.destinationVaults[0].id:"");const localPath=resource.localPath || resource.name;$("destination-path").value=localPath.split("/").pop();
    locationFolder=localPath.includes("/")?localPath.slice(0,localPath.lastIndexOf("/")):"";
    $("location-dialog").querySelector(".error").textContent="";$("location-dialog").showModal();void loadLocationTree(locationFolder);
  }
  $("location-form").onsubmit=event=>{event.preventDefault();run(async()=>{
    if(!locationReady)return;
    if($("destination-vault").value && /[\\/]/.test($("destination-path").value))throw new Error(translateIgnis("Invalid local name."));
    await api("destination",{id:placed.id,vault:$("destination-vault").value || null,localPath:[locationFolder,$("destination-path").value].filter(Boolean).join("/")});
    $("location-dialog").close();await reload();
  },$("location-dialog"));};
  function manage(resource){
    if(busy||locked)return;
    managed=resource;draft=resource.grants.map(g=>({...g}));
    $("manage-heading").textContent=translateIgnis("Manage resource")+" "+resource.name;
    $("manage-dialog").querySelector(".error").textContent="";
    renderGrants();
    if(!$("manage-dialog").open)$("manage-dialog").showModal();
  }
  function renderGrants(){
    const rows=draft.map(grant=>{
      const select=node("select");select.className="dropdown";select.setAttribute("aria-label",translateIgnis("Permission for ")+grant.login);
      for(const [value,title] of [["reader",translateIgnis("Read")],["editor",translateIgnis("Read / Write")]]){const option=node("option",title);option.value=value;select.append(option);}
      select.value=grant.role;
      const actions=node("div");actions.className="toolbar";
      select.onchange=()=>{if(!busy)grant.role=select.value;};
      const remove=iconButton(translateIgnis("Remove access for ")+grant.login,["M3 6h18","M9 6V4h6v2","M5 6l1 14h12l1-14","M10 10v6","M14 10v6"],()=>{
        if(busy)return;draft=draft.filter(g=>g!==grant);renderGrants();
      });actions.append(remove);
      return [grant.login,select,actions];
    });
    $("grants").replaceChildren(rows.length?table([translateIgnis("User"),translateIgnis("Permission"),translateIgnis("Actions")],rows):node("p",translateIgnis("No direct recipients.")));
  }
  for(const el of root.querySelectorAll("[data-close]"))el.onclick=()=>{if(!busy)$(el.dataset.close).close();};
  for(const dialog of root.querySelectorAll("dialog"))dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault();});
  let locationFolder="",locationTree={},locationGeneration=0,locationReady=false;
  const locationExpanded=new Set();
  const parentPath=path=>path.includes("/")?path.slice(0,path.lastIndexOf("/")):"";
  function renderLocationTree(){
    const query=$("location-search").value.trim().toLocaleLowerCase();
    const paths=Object.keys(locationTree).filter(path=>locationTree[path].type==="directory" && path.split("/").every(part=>part && !part.startsWith(".")));
    const included=new Set();
    for(const path of paths.filter(path=>!query||path.toLocaleLowerCase().includes(query))){let p=path;while(p){included.add(p);p=parentPath(p);}}
    const rootOpen=!!query||locationExpanded.has("");
    const rows=[{path:"",name:translateIgnis("Vault root"),kind:"directory",depth:0,children:paths.length>0,open:rootOpen}];
    function visit(parent,depth){for(const path of paths.filter(p=>parentPath(p)===parent&&included.has(p)).sort((a,b)=>a.localeCompare(b))){
      const open=!!query||locationExpanded.has(path);
      rows.push({path,name:path.split("/").pop(),kind:"directory",depth,children:paths.some(p=>parentPath(p)===path),open});
      if(open)visit(path,depth+1);
    }}if(rootOpen)visit("",1);
    resourceTree.render($("location-tree"),rows,{selected:locationFolder,translate:translateIgnis,
      onSelect:entry=>{locationFolder=entry.path;renderLocationTree();},
      onToggle:entry=>{if(query)return;if(locationExpanded.has(entry.path))locationExpanded.delete(entry.path);else locationExpanded.add(entry.path);renderLocationTree();}});
    $("location-selection").textContent=translateIgnis("Destination: ")+(locationFolder||translateIgnis("Vault root"));
  }
  async function loadLocationTree(selected=""){
    const generation=++locationGeneration,vault=$("destination-vault").value;
    locationReady=false;locationFolder=selected;locationExpanded.clear();locationExpanded.add("");$("location-search").value="";
    $("location-folders").hidden=!vault;$("destination-path").disabled=!vault;
    $("location-form").querySelector('[type="submit"]').disabled=!!vault;
    $("location-tree").replaceChildren();$("location-selection").textContent="";
    if(!vault){locationReady=true;return;}
    try{
      const response=await fetch("/api/fs/tree?vault="+encodeURIComponent(vault),{credentials:"same-origin",cache:"no-store",headers:{"X-Ignis-Context":context}});
      if(!response.ok)throw new Error(translateIgnis("Unable to load folders."));
      const data=await response.json();if(generation!==locationGeneration||locked)return;
      locationTree=data;
      if(selected && data[selected]?.type!=="directory")throw new Error(translateIgnis("Destination folder is unavailable."));
      let p=selected;while(p){locationExpanded.add(p);p=parentPath(p);}
      locationReady=true;renderLocationTree();$("location-form").querySelector('[type="submit"]').disabled=false;
    }catch(error){if(generation===locationGeneration)$("location-dialog").querySelector(".error").textContent=error.message;}
  }
  $("destination-vault").onchange=()=>{ $("location-dialog").querySelector(".error").textContent="";void loadLocationTree(); };
  $("location-search").oninput=renderLocationTree;
  $("location-dialog").addEventListener("close",()=>{locationGeneration++;locationReady=false;});

  $("create-dialog").addEventListener("close",()=>{pickerGeneration++;});
  function selectResource(path){
    selectedPath=path;$("selection").textContent=translateIgnis("Selected: ")+path;$("create-submit").disabled=false;
    for(const item of $("picker").querySelectorAll(".resource-tree-select"))item.setAttribute("aria-pressed",String(item.dataset.path===path));
  }
  let treeEntries=new Map(), expanded=new Set();
  function renderEntries(container,entries,parent,vault,generation){
    treeEntries.set(parent,entries);
    const query=$("share-search").value.trim().toLocaleLowerCase();
    const included=new Set();
    if(query)for(const [folder,children] of treeEntries)for(const entry of children){
      let path=folder?folder+"/"+entry.name:entry.name;
      if(path.toLocaleLowerCase().includes(query))while(path){included.add(path);path=parentPath(path);}
    }
    const rows=[];
    function visit(folder,depth){for(const entry of [...(treeEntries.get(folder)||[])].sort((a,b)=>(a.kind===b.kind?0:a.kind==="directory"?-1:1)||a.name.localeCompare(b.name))){
      const path=folder?folder+"/"+entry.name:entry.name;
      if(query&&!included.has(path))continue;
      rows.push({...entry,path,depth,children:entry.kind==='directory',open:!!query||expanded.has(path)});
      if(query||expanded.has(path))visit(path,depth+1);
    }}
    visit('',0);
    resourceTree.render(container,rows,{selected:selectedPath,translate:translateIgnis,
      onSelect:entry=>selectResource(entry.path),
      onToggle:async entry=>{
        if(query)return;
        if(expanded.has(entry.path)){expanded.delete(entry.path);renderEntries(container,treeEntries.get(''),'',vault,generation);return;}
        try{const data=await api('browse',{vault,path:entry.path});
          if(generation!==pickerGeneration||locked)return;
          treeEntries.set(entry.path,data.entries);expanded.add(entry.path);renderEntries(container,treeEntries.get(''),'',vault,generation);
        }catch(error){if(generation===pickerGeneration)$("create-dialog").querySelector('.error').textContent=error.message;}
      }});
  }
  let searchTimer;
  onDispose(()=>{locked=true;pickerGeneration++;locationGeneration++;clearTimeout(searchTimer);});
  let searchRun=0;
  $("share-search").oninput=()=>{
    clearTimeout(searchTimer);
    const runId=++searchRun,generation=pickerGeneration,vault=$("vault").value;
    searchTimer=setTimeout(async()=>{
      try{
        // Use the authorized sharing browser, including its path exclusions.
        // Cache each directory and stop immediately when the query or vault changes.
        const pending=[""];
        while(pending.length && $("share-search").value.trim()){
          if(runId!==searchRun||generation!==pickerGeneration||locked)return;
          const folder=pending.shift();
          if(!treeEntries.has(folder)){
            const data=await api("browse",{vault,path:folder});
            if(runId!==searchRun||generation!==pickerGeneration||locked)return;
            treeEntries.set(folder,data.entries);
          }
          for(const entry of treeEntries.get(folder))if(entry.kind==="directory")pending.push(folder?folder+"/"+entry.name:entry.name);
        }
        if(runId===searchRun&&generation===pickerGeneration&&!locked)renderEntries($("picker"),treeEntries.get("")||[],"",vault,generation);
      }catch(error){if(runId===searchRun&&generation===pickerGeneration)$("create-dialog").querySelector(".error").textContent=error.message;}
    },250);
  };
  async function loadTree(){
    clearTimeout(searchTimer);searchRun++;$("share-search").value="";
    const generation=++pickerGeneration,vault=$("vault").value;
    treeEntries=new Map();expanded=new Set();
    selectedPath="";$("selection").textContent=translateIgnis("Select a file or folder.");$("create-submit").disabled=true;
    $("picker").replaceChildren(node("p",translateIgnis("Loading vault…")));
    $("create-dialog").querySelector(".error").textContent="";
    try{
      const data=await api("browse",{vault,path:""});
      if(generation!==pickerGeneration || locked)return;
      renderEntries($("picker"),data.entries,"",vault,generation);
      return true;
    }catch(error){if(generation===pickerGeneration){$("picker").replaceChildren();$("create-dialog").querySelector(".error").textContent=error.message;}}
  }
  async function openCreate(vault, path){
    if(busy||locked)return;
    $("create-form").reset();$("recipient").setCustomValidity("");$("vault").replaceChildren(...catalog.ownedVaults.map(v=>{const option=node("option",v.name);option.value=v.id;return option;}));
    if(vault)$("vault").value=vault;
    $("create-dialog").showModal();
    if(await loadTree() && path)selectResource(path);
  }
  $("new-share").onclick=()=>{void openCreate();};
  $("vault").onchange=()=>{void loadTree();};
  $("recipient").addEventListener("input",()=>$("recipient").setCustomValidity(""));
  $("permission").addEventListener("change",()=>$("recipient").setCustomValidity(""));
  $("create-form").onsubmit=event=>{event.preventDefault();if(!selectedPath)return;run(async()=>{
    await api("create",{vault:$("vault").value,path:selectedPath,login:$("recipient").value,role:$("permission").value});
    $("create-dialog").close();await reload();
  },$("create-dialog"));};
  $("add-access").onclick=()=>{
    if(busy||locked)return;
    $("grant-form").reset();$("grant-login").setCustomValidity("");
    $("grant-dialog").querySelector(".error").textContent="";$("grant-dialog").showModal();$("grant-login").focus();
  };
  $("grant-login").addEventListener("input",()=>$("grant-login").setCustomValidity(""));
  $("grant-role").addEventListener("change",()=>$("grant-login").setCustomValidity(""));
  $("grant-form").onsubmit=event=>{event.preventDefault();run(async()=>{
    const login=$("grant-login").value.trim().toLowerCase(),role=$("grant-role").value;
    await api("validateGrant",{id:managed.id,revision:managed.revision,login,role});
    const existing=draft.find(g=>g.login===login);
    if(existing)existing.role=role;else draft.push({login,role});
    renderGrants();$("grant-dialog").close();
  },$("grant-dialog"));};
  $("save-resource").onclick=()=>run(async()=>{
    const changes=draft.filter(g=>!managed.grants.some(old=>old.login===g.login && old.role===g.role)).map(({login,role})=>({login,role}));
    for(const old of managed.grants)if(!draft.some(g=>g.login===old.login))changes.push({login:old.login,role:null});
    if(changes.length)await api("grants",{id:managed.id,revision:managed.revision,changes});
    $("manage-dialog").close();await reload();
  },$("manage-dialog"));
  let externalRefresh=false;
  const refreshExternal=()=>{
    if(locked)return;
    if(busy || [...root.querySelectorAll("dialog")].some(dialog=>dialog.open)){externalRefresh=true;return;}
    externalRefresh=false;void run(reload);
  };
  listen(window, "ignis:state-changed",event=>{if(event.detail?.shares)refreshExternal();});
  listen(root, "close",()=>{if(externalRefresh)setTimeout(refreshExternal,0);},true);
  {const channel=openChannel("ignis-auth");if(channel)channel.onmessage=()=>lock();}
  run(async()=>{const response=await fetch("/api/auth/session",{credentials:"same-origin",cache:"no-store"});if(!response.ok){location.replace("/login");return;}const session=await response.json();window.IgnisI18n?.useAccount(session.user.id);context=session.sessionId;if(!context){location.replace("/login");return;}if(scope.initialResource && context!==scope.initialResource.session)throw new Error(translateIgnis("Session unavailable"));await reload();$("workspace").hidden=false;}).then(async()=>{
    const initial=scope.initialResource;
    if(!initial || !catalog || locked)return;
    try {
      scope.assertContext?.();
      if(initial.id){
        const resource=catalog.resources.find(r=>r.id===initial.id);
        if(!resource)throw new Error(translateIgnis("Shared resource unavailable"));
        if(initial.action === "revoke"){
          if(!resource.owned)throw new Error(translateIgnis("Shared resource unavailable"));
          if(await confirmAction(translateIgnis("Stop sharing"),translateIgnis("Stop sharing “{p0}” with all recipients?",{p0:resource.name}),translateIgnis("Stop sharing"),scope.onResourceDialogOpened)){
            await api("revoke",{action:"revoke",id:resource.id,revision:resource.revision});
          }
          scope.onResourceActionFinished?.();
          return;
        }
        if(resource.owned)manage(resource);else locationDialog(resource);
        scope.onResourceDialogOpened?.($(resource.owned?"manage-dialog":"location-dialog"));
        return;
      }
      if(!catalog.ownedVaults.some(v=>v.id===initial.vault))throw new Error(translateIgnis("Only the vault owner can share its resources."));
      const resource=catalog.resources.find(r=>r.owned && r.vault===initial.vault && r.path===initial.path);
      if(resource){
        if(!resource.available)throw new Error(translateIgnis("This shared resource is unavailable. Review it in Shared resources."));
        manage(resource);
        scope.onResourceDialogOpened?.($("manage-dialog"));
      }else{
        await openCreate(initial.vault,initial.path);
        scope.onResourceDialogOpened?.($("create-dialog"));
      }
    }catch(error){$("status").textContent=error.message;}
  });
}
