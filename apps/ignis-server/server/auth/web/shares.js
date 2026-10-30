(() => {
  const $=id=>document.getElementById(id);
  let context, catalog, managed, opened, relative="", file, busy=false, locked=false, pickerPath="", editorOriginal="";
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  function lock(){locked=true;for(const dialog of document.querySelectorAll("dialog"))dialog.close();$("workspace").hidden=true;$("status").textContent="Your session has ended or changed. Return to Account to sign in again.";}
  async function api(operation,input){
    if(locked)throw new Error("Session unavailable");
    const headers={"X-Ignis-Context":context};
    if(operation){const response=await fetch("/api/auth/csrf",{credentials:"same-origin",cache:"no-store",headers});if(!response.ok)throw new Error("Unable to check your session.");headers["X-Ignis-Csrf"]=(await response.json()).csrfToken;headers["Content-Type"]="application/json";}
    const response=await fetch("/api/shares",{method:operation?"POST":"GET",credentials:"same-origin",cache:"no-store",headers,...(operation?{body:JSON.stringify({operation,input})}:{})});
    if(response.status===401 || response.headers.get("content-type")?.includes("text/html")){lock();throw new Error("Session unavailable");}
    const data=await response.json();if(!response.ok){if(data.code==="AUTH_CONTEXT_CHANGED")lock();throw new Error(data.error || "Request failed");}return data;
  }
  async function run(fn,dialog){if(busy||locked)return;busy=true;const status=dialog?dialog.querySelector(".error"):$("status");status.textContent="";try{await fn();}catch(error){(dialog && !dialog.open ? $("status") : status).textContent=error.message;}finally{busy=false;}}
  const button=(text,action,secondary=true)=>{const el=node("button",text);el.type="button";if(secondary)el.className="secondary";el.onclick=action;return el;};
  function table(headers,rows){const wrap=node("div");wrap.className="table-scroll";const el=node("table"),head=node("tr");for(const name of headers)head.append(node("th",name));const thead=node("thead");thead.append(head);el.append(thead);const body=node("tbody");for(const cells of rows){const row=node("tr");for(const value of cells){const cell=node("td");cell.append(typeof value==="string"?document.createTextNode(value):value);row.append(cell);}body.append(row);}el.append(body);wrap.append(el);return wrap;}
  function render(){
    for(const [id,owned] of [["received",false],["owned",true]]){
      const rows=catalog.resources.filter(r=>r.owned===owned).map(resource=>{
        const actions=node("div");actions.className="toolbar";
        const open=button("Open",()=>run(async()=>{opened=resource;relative="";await view();$("viewer-dialog").showModal();}));open.disabled=!resource.available;actions.append(open);
        if(owned)actions.append(button("Manage",()=>manage(resource)));
        else {
          const select=node("select");select.setAttribute("aria-label","Destination vault for "+resource.name);
          const none=node("option","Not placed — choose a vault");none.value="";select.append(none);
          for(const vault of catalog.destinationVaults){const option=node("option",vault.name);option.value=vault.id;select.append(option);}
          select.value=resource.destination || "";
          const local=node("input");local.value=resource.localPath || resource.name;local.setAttribute("aria-label","Local path for "+resource.name);local.title="Local name and optional existing destination folder";
          actions.append(select,local,button("Save location",()=>run(async()=>{await api("destination",{id:resource.id,vault:select.value || null,localPath:local.value});await reload();})));
        }
        return [resource.name,resource.kind,owned?(catalog.ownedVaults.find(v=>v.id===resource.vault)?.name || "Vault")+" / "+resource.path:resource.owner,resource.available?(owned?"Owner":resource.role==="editor"?"Read / Write":"Read"):"Unavailable",actions];
      });
      $(id).replaceChildren(rows.length?table(["Resource","Type",owned?"Path":"Owner","Access","Actions"],rows):node("p","No shared resources."));
    }
    $("new-share").disabled=!catalog.ownedVaults.length;
  }
  async function reload(){catalog=await api();document.querySelector('label[for="upload"]').textContent=`Upload a file (${catalog.limits.maxFileMiB} MiB maximum)`;render();}
  function manage(resource){managed=resource;$("manage-heading").textContent="Sharing · "+resource.name;$("manage-dialog").querySelector(".error").textContent="";$("grant-form").reset();$("grants").replaceChildren(table(["User","Access",""],resource.grants.map(g=>[g.login,g.role==="editor"?"Read / Write":"Read",button("Remove",()=>run(async()=>{await api("grant",{action:"grant",id:resource.id,revision:resource.revision,login:g.login,role:null});$("manage-dialog").close();await reload();},$("manage-dialog")))])));$("manage-dialog").showModal();}
  const dirty=()=>file?.kind==="file" && !$("editor").hidden && !$("editor").readOnly && $("editor").value!==editorOriginal;
  for(const el of document.querySelectorAll("[data-close]"))el.onclick=()=>{if(!busy && (el.dataset.close!=="viewer-dialog" || !dirty() || confirm("Discard unsaved edits?")))$(el.dataset.close).close();};
  for(const dialog of document.querySelectorAll("dialog"))dialog.addEventListener("cancel",event=>{if(busy || (dialog.id==="viewer-dialog" && dirty() && !confirm("Discard unsaved edits?")))event.preventDefault();});
  $("reload").onclick=()=>run(reload);
  $("new-share").onclick=()=>{$("create-form").reset();$("picker").replaceChildren();$("browse-up").hidden=true;$("create-dialog").querySelector(".error").textContent="";$("vault").replaceChildren(...catalog.ownedVaults.map(v=>{const option=node("option",v.name);option.value=v.id;return option;}));$("create-dialog").showModal();};
  async function browse(path){const data=await api("browse",{vault:$("vault").value,path});pickerPath=path;$("resource-path").value=path;$("browse-up").hidden=!path;$("picker").replaceChildren(table(["Name","Type",""],data.entries.map(entry=>{const name=path?path+"/"+entry.name:entry.name;const actions=node("div");actions.className="toolbar";actions.append(button("Select",()=>{$("resource-path").value=name;}));if(entry.kind==="directory")actions.append(button("Open",()=>run(()=>browse(name),$("create-dialog"))));return [entry.name,entry.kind,actions];})));}
  $("browse-root").onclick=()=>run(()=>browse(""),$("create-dialog"));$("browse-up").onclick=()=>run(()=>browse(pickerPath.split("/").slice(0,-1).join("/")),$("create-dialog"));$("vault").onchange=()=>{$("picker").replaceChildren();$("resource-path").value="";$("browse-up").hidden=true;};
  $("create-form").onsubmit=event=>{event.preventDefault();run(async()=>{await api("create",{vault:$("vault").value,path:$("resource-path").value,login:$("recipient").value,role:$("permission").value});$("create-dialog").close();await reload();},$("create-dialog"));};
  $("grant-form").onsubmit=event=>{event.preventDefault();run(async()=>{await api("grant",{action:"grant",id:managed.id,revision:managed.revision,login:$("grant-login").value,role:$("grant-role").value});$("manage-dialog").close();await reload();},$("manage-dialog"));};
  $("revoke").onclick=()=>run(async()=>{if(!confirm("Stop sharing this resource with all recipients? Other shares and vault memberships are unaffected."))return;await api("revoke",{action:"revoke",id:managed.id,revision:managed.revision});$("manage-dialog").close();await reload();},$("manage-dialog"));
  const join=name=>relative?relative+"/"+name:name;
  function bytes(){return Uint8Array.from(atob(file.content),c=>c.charCodeAt(0));}
  function base64(data){let text="";for(let i=0;i<data.length;i+=8192)text+=String.fromCharCode(...data.subarray(i,i+8192));return btoa(text);}
  async function view(){
    const data=await api("read",{id:opened.id,path:relative});file=data;$("saved").textContent="";
    $("viewer-heading").textContent=opened.name;$("location").textContent=relative || "/";
    $("up").hidden=!relative;$("entries").replaceChildren();$("editor").value="";$("upload").value="";$("folder-name").value="";
    $("viewer-dialog").querySelector(".error").textContent="";
    const directory=data.kind==="directory",write=data.role==="editor";
    $("file-area").hidden=directory;$("new-folder").hidden=!directory||!write;$("upload-area").hidden=!write;$("remove").hidden=!write||!relative;
    if(directory){$("entries").append(table(["Name","Type",""],data.entries.map(entry=>[entry.name,entry.kind,button("Open",()=>run(async()=>{const previous=relative;relative=join(entry.name);try{await view();}catch(e){relative=previous;throw e;}},$("viewer-dialog")))])));}
    else{let text=null;try{const value=new TextDecoder("utf-8",{fatal:true}).decode(bytes());if(!value.includes("\0"))text=value;}catch{/* Binary download only. */}
      $("editor").hidden=text===null;$("binary").hidden=text!==null;$("editor").value=text || "";editorOriginal=$("editor").value;$("editor").readOnly=!write;$("save").hidden=!write||text===null;}
  }
  $("refresh-resource").onclick=()=>run(async()=>{if(dirty()&&!confirm("Reload and discard unsaved edits?"))return;await view();},$("viewer-dialog"));
  $("up").onclick=()=>run(async()=>{if(dirty()&&!confirm("Leave this file and discard unsaved edits?"))return;relative=relative.split("/").slice(0,-1).join("/");await view();},$("viewer-dialog"));
  $("save").onclick=()=>run(async()=>{const submittedText=$("editor").value;const encoded=new TextEncoder().encode(submittedText);if(encoded.length>catalog.limits.maxFileBytes)throw new Error(`The file exceeds the ${catalog.limits.maxFileMiB} MiB limit.`);const content=base64(encoded);const result=await api("write",{action:"write",id:opened.id,path:relative,etag:file.etag,content});file.etag=result.etag;file.content=content;editorOriginal=submittedText;$("saved").textContent="Changes saved.";},$("viewer-dialog"));
  $("editor").oninput=()=>{$("saved").textContent="";};
  $("download").onclick=()=>{const url=URL.createObjectURL(new Blob([bytes()],{type:"application/octet-stream"}));const link=node("a");link.href=url;link.download=file.name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  $("new-folder").onsubmit=event=>{event.preventDefault();run(async()=>{const name=$("folder-name").value;if(name.includes("/"))throw new Error("Enter a single folder name.");await api("mkdir",{action:"mkdir",id:opened.id,path:join(name),etag:null});await view();},$("viewer-dialog"));};
  $("send-upload").onclick=()=>run(async()=>{const upload=$("upload").files[0];if(!upload)throw new Error("Choose a file first.");if(upload.size>catalog.limits.maxFileBytes)throw new Error(`The file exceeds the ${catalog.limits.maxFileMiB} MiB limit.`);if(file.kind==="file"&&!confirm("Replace this file with the upload?"))return;
    await api("write",{action:"write",id:opened.id,path:file.kind==="directory"?join(upload.name):relative,etag:file.kind==="directory"?null:file.etag,content:base64(new Uint8Array(await upload.arrayBuffer()))});await view();},$("viewer-dialog"));
  $("remove").onclick=()=>run(async()=>{if(!confirm("Permanently delete this item? Folders must be empty."))return;await api("remove",{action:"remove",id:opened.id,path:relative,etag:file.kind==="file"?file.etag:"directory"});relative=relative.split("/").slice(0,-1).join("/");await view();},$("viewer-dialog"));
  if(typeof BroadcastChannel==="function"){const channel=new BroadcastChannel("ignis-auth");channel.onmessage=()=>lock();}
  run(async()=>{const response=await fetch("/api/auth/session",{credentials:"same-origin",cache:"no-store"});if(!response.ok){location.replace("/login");return;}const session=await response.json();context=session.sessionId;if(!context){location.replace("/login");return;}await reload();$("workspace").hidden=false;});
})();
