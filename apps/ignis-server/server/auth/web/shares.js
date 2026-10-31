(() => {
  const $=id=>document.getElementById(id);
  let context, catalog, managed, placed, busy=false, locked=false, selectedPath="", pickerGeneration=0;
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  function lock(){locked=true;for(const dialog of document.querySelectorAll("dialog"))dialog.close();$("workspace").hidden=true;$("status").textContent="Your session has ended or changed. Return to Account to sign in again.";}
  async function api(operation,input){
    if(locked)throw new Error("Session unavailable");
    const headers={"X-Ignis-Context":context};
    if(operation){const response=await fetch("/api/auth/csrf",{credentials:"same-origin",cache:"no-store",headers});if(!response.ok)throw new Error("Unable to check your session.");headers["X-Ignis-Csrf"]=(await response.json()).csrfToken;headers["Content-Type"]="application/json";}
    const response=await fetch("/api/shares",{method:operation?"POST":"GET",credentials:"same-origin",cache:"no-store",headers,...(operation?{body:JSON.stringify({operation,input})}:{})});
    if(response.status===401 || response.headers.get("content-type")?.includes("text/html")){lock();throw new Error("Session unavailable");}
    const data=await response.json();if(locked)throw new Error("Session unavailable");if(!response.ok){if(data.code==="AUTH_CONTEXT_CHANGED")lock();throw new Error(data.error || "Request failed");}return data;
  }
  async function run(fn,dialog){if(busy||locked)return;busy=true;const status=dialog?dialog.querySelector(".error"):$("status");status.textContent="";try{await fn();}catch(error){(dialog && !dialog.open ? $("status") : status).textContent=error.message;}finally{busy=false;}}
  const button=(text,action,secondary=true)=>{const el=node("button",text);el.type="button";if(secondary)el.className="secondary table-action";el.onclick=action;return el;};
  function iconButton(label,paths,action){
    const el=button("",action);el.className="icon-button";el.title=label;el.setAttribute("aria-label",label);
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    for(const [key,value] of Object.entries({viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"1.7","stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true"}))svg.setAttribute(key,value);
    for(const d of paths){const path=document.createElementNS(svg.namespaceURI,"path");path.setAttribute("d",d);svg.append(path);}
    el.append(svg);return el;
  }
  function table(headers,rows){const wrap=node("div");wrap.className="table-scroll";const el=node("table"),head=node("tr");for(const name of headers)head.append(node("th",name));const thead=node("thead");thead.append(head);el.append(thead);const body=node("tbody");for(const cells of rows){const row=node("tr");for(const value of cells){const cell=node("td");cell.append(typeof value==="string"?document.createTextNode(value):value);row.append(cell);}body.append(row);}el.append(body);wrap.append(el);return wrap;}
  function render(){
    for(const [id,owned] of [["received",false],["owned",true]]){
      const resources=catalog.resources.filter(r=>r.owned===owned);
      const rows=resources.map(resource=>{
        const title=node("div",resource.name);
        if(!owned){
          const vault=catalog.destinationVaults.find(v=>v.id===resource.destination);
          const detail=node("span",vault?`${vault.name} / ${resource.localPath || resource.name}`:"Not placed in a vault");
          detail.className="resource-detail";title.append(detail);
        }
        if(owned && !resource.available){const state=node("span","Unavailable");state.className="resource-detail";title.append(state);}
        const actions=node("div");actions.className="toolbar";
        actions.append(owned?button("Manage",()=>manage(resource)):button("Location",()=>locationDialog(resource)));
        return [title,resource.kind==="directory"?"Folder":"File",owned?(catalog.ownedVaults.find(v=>v.id===resource.vault)?.name || "Vault")+" / "+resource.path:resource.owner,...(owned?[]:[resource.available?(resource.role==="editor"?"Read / Write":"Read"):"Unavailable"]),actions];
      });
      $(id).replaceChildren(rows.length?table(["Resource","Type",owned?"Path":"Owner",...(owned?[]:["Access"]),"Actions"],rows):node("p","No shared resources."));
    }
    $("new-share").disabled=!catalog.ownedVaults.length;
  }
  async function reload(){catalog=await api();render();}
  function locationDialog(resource){
    placed=resource;$("location-resource").textContent=resource.name;
    const select=$("destination-vault");const none=node("option","Not placed in a vault");none.value="";
    select.replaceChildren(none,...catalog.destinationVaults.map(v=>{const option=node("option",v.name);option.value=v.id;return option;}));
    select.value=resource.destination || "";$("destination-path").value=resource.localPath || resource.name;
    $("location-dialog").querySelector(".error").textContent="";$("location-dialog").showModal();
  }
  $("location-form").onsubmit=event=>{event.preventDefault();run(async()=>{
    await api("destination",{id:placed.id,vault:$("destination-vault").value || null,localPath:$("destination-path").value});
    $("location-dialog").close();await reload();
  },$("location-dialog"));};
  async function updateGrant(login,role){
    await api("grant",{action:"grant",id:managed.id,revision:managed.revision,login,role});
    await reload();const updated=catalog.resources.find(r=>r.id===managed.id);
    if(!updated){$("manage-dialog").close();return;}
    manage(updated);
  }
  function manage(resource){
    managed=resource;$("manage-resource").textContent=resource.name;
    $("manage-dialog").querySelector(".error").textContent="";
    const rows=resource.grants.map(grant=>{
      const select=node("select");select.setAttribute("aria-label","Permission for "+grant.login);
      for(const [value,title] of [["reader","Read"],["editor","Read / Write"]]){const option=node("option",title);option.value=value;select.append(option);}
      select.value=grant.role;
      const actions=node("div");actions.className="toolbar";
      const save=iconButton("Save permission for "+grant.login,["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z","M17 21v-8H7v8","M7 3v5h8"],()=>run(()=>updateGrant(grant.login,select.value),$("manage-dialog")));save.disabled=true;
      select.onchange=()=>{save.disabled=select.value===grant.role;};
      const remove=iconButton("Remove access for "+grant.login,["M3 6h18","M9 6V4h6v2","M5 6l1 14h12l1-14","M10 10v6","M14 10v6"],()=>run(async()=>{
        if(confirm(`Remove ${grant.login}'s access to this resource? Other permissions are unaffected.`))await updateGrant(grant.login,null);
      },$("manage-dialog")));remove.classList.add("danger");actions.append(save,remove);
      return [grant.login,select,actions];
    });
    $("grants").replaceChildren(rows.length?table(["User","Permission","Actions"],rows):node("p","No direct recipients."));
    if(!$("manage-dialog").open)$("manage-dialog").showModal();
  }
  for(const el of document.querySelectorAll("[data-close]"))el.onclick=()=>{if(!busy)$(el.dataset.close).close();};
  for(const dialog of document.querySelectorAll("dialog"))dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault();});
  for (const toggle of document.querySelectorAll(".setup-help-toggle")) {
    const tip = document.getElementById(toggle.getAttribute("aria-controls"));
    const region = toggle.parentElement;
    const show = (open) => {
      tip.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      if (open) toggle.setAttribute("aria-describedby", tip.id);
      else toggle.removeAttribute("aria-describedby");
    };
    toggle.addEventListener("click", () => show(true));
    region.addEventListener("mouseenter", () => show(true));
    region.addEventListener("mouseleave", () => show(false));
    region.addEventListener("focusout", (event) => {
      if (!region.contains(event.relatedTarget)) show(false);
    });
    toggle.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); show(false); }
    });
    document.addEventListener("click", (event) => {
      if (!region.contains(event.target)) show(false);
    });
  }
  $("location-dialog").addEventListener("close",()=>{ $("local-path-help").hidden=true; document.querySelector(".setup-help-toggle").setAttribute("aria-expanded","false"); });
  $("back-to-account").onclick=()=>window.location.assign("/account");
  $("reload").onclick=()=>run(reload);
  $("create-dialog").addEventListener("close",()=>{pickerGeneration++;});
  function selectResource(path){
    selectedPath=path;$("selection").textContent="Selected: "+path;$("create-submit").disabled=false;
    for(const item of $("picker").querySelectorAll(".tree-select"))item.setAttribute("aria-pressed",String(item.dataset.path===path));
  }
  function renderEntries(container,entries,parent,vault,generation){
    container.replaceChildren();
    if(!entries.length){container.append(node("p","This folder is empty."));return;}
    for(const entry of [...entries].sort((a,b)=>(a.kind===b.kind?0:a.kind==="directory"?-1:1)||a.name.localeCompare(b.name))){
      const path=parent?parent+"/"+entry.name:entry.name;
      const branch=node("div"),row=node("div");row.className="tree-row";branch.append(row);
      const children=node("div");children.className="tree-children";children.hidden=true;
      if(entry.kind==="directory"){
        const expand=button("▸",async()=>{
          if(expand.disabled)return;
          if(!children.hidden){children.hidden=true;expand.textContent="▸";expand.setAttribute("aria-expanded","false");return;}
          expand.disabled=true;
          try{
            const data=await api("browse",{vault,path});
            if(generation!==pickerGeneration || locked)return;
            renderEntries(children,data.entries,path,vault,generation);children.hidden=false;expand.textContent="▾";expand.setAttribute("aria-expanded","true");
          }catch(error){if(generation===pickerGeneration)$("create-dialog").querySelector(".error").textContent=error.message;}
          finally{expand.disabled=false;}
        },false);expand.className="tree-toggle";expand.setAttribute("aria-label","Expand or collapse "+entry.name);expand.setAttribute("aria-expanded","false");row.append(expand);
      }else{const spacer=node("span");spacer.className="tree-spacer";row.append(spacer);}
      const choose=button((entry.kind==="directory"?"📁 ":"📄 ")+entry.name,()=>selectResource(path),false);
      choose.className="tree-select";choose.dataset.path=path;choose.setAttribute("aria-pressed",String(path===selectedPath));
      row.append(choose);branch.append(children);container.append(branch);
    }
  }
  async function loadTree(){
    const generation=++pickerGeneration,vault=$("vault").value;
    selectedPath="";$("selection").textContent="Select a file or folder.";$("create-submit").disabled=true;
    $("picker").replaceChildren(node("p","Loading vault…"));
    $("create-dialog").querySelector(".error").textContent="";
    try{
      const data=await api("browse",{vault,path:""});
      if(generation!==pickerGeneration || locked)return;
      const root=node("div",catalog.ownedVaults.find(v=>v.id===vault)?.name || "Vault");root.className="tree-root";
      const children=node("div");renderEntries(children,data.entries,"",vault,generation);$("picker").replaceChildren(root,children);
    }catch(error){if(generation===pickerGeneration){$("picker").replaceChildren();$("create-dialog").querySelector(".error").textContent=error.message;}}
  }
  $("new-share").onclick=()=>{
    if(busy||locked)return;
    $("create-form").reset();$("vault").replaceChildren(...catalog.ownedVaults.map(v=>{const option=node("option",v.name);option.value=v.id;return option;}));
    $("create-dialog").showModal();void loadTree();
  };
  $("vault").onchange=()=>{void loadTree();};
  $("create-form").onsubmit=event=>{event.preventDefault();if(!selectedPath)return;run(async()=>{
    await api("create",{vault:$("vault").value,path:selectedPath,login:$("recipient").value,role:$("permission").value});
    $("create-dialog").close();await reload();
  },$("create-dialog"));};
  $("add-access").onclick=()=>{
    if(busy||locked)return;
    $("grant-form").reset();$("grant-resource").textContent=managed.name;
    $("grant-dialog").querySelector(".error").textContent="";$("grant-dialog").showModal();$("grant-login").focus();
  };
  $("grant-form").onsubmit=event=>{event.preventDefault();run(async()=>{
    await updateGrant($("grant-login").value,$("grant-role").value);$("grant-dialog").close();
  },$("grant-dialog"));};
  $("revoke").onclick=()=>run(async()=>{
    if(!confirm("Stop sharing this resource with all recipients? Other shares and vault memberships are unaffected."))return;
    await api("revoke",{action:"revoke",id:managed.id,revision:managed.revision});$("manage-dialog").close();await reload();
  },$("manage-dialog"));
  if(typeof BroadcastChannel==="function"){const channel=new BroadcastChannel("ignis-auth");channel.onmessage=()=>lock();}
  run(async()=>{const response=await fetch("/api/auth/session",{credentials:"same-origin",cache:"no-store"});if(!response.ok){location.replace("/login");return;}const session=await response.json();context=session.sessionId;if(!context){location.replace("/login");return;}await reload();$("workspace").hidden=false;});
})();
