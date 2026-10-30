import { normalize } from "../util/path.js";
import { resolvePath } from "./transforms.js";
export const SHARED_ROOT = "Shared with me";
const fail = (code, message = "Shared resource unavailable") => {throw Object.assign(new Error(message),{code});};
const under = (path,root) => path===root || path.startsWith(root+"/");
function wire(input){const value={...input};delete value.role;return value;}
const base64 = bytes => {let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);};
const bytes = value => Uint8Array.from(atob(value),character=>character.charCodeAt(0));
export function createSharedFiles({metadataCache,watch,currentContext,request=fetch,createXHR=()=>new XMLHttpRequest(),onFailure=()=>{},onNotice=()=>{},onRemoved=()=>{}}) {
  let scope=null, enabled=false, outgoing=[], mounted=new Map(), tree=Object.create(null), timer=null, refreshing=false, maxBytes=0;
  const states=new Map(),reserved=new Set(),subscribers=new Set();
  function context(){const value=currentContext();if(!scope?.sessionId || value?.sessionId!==scope.sessionId || value?.vault!==scope.vault)fail("AUTH_CONTEXT_CHANGED","Session or vault changed");}
  function owns(path){return enabled && [...reserved].some(root=>under(normalize(path),root));}
  function containsMount(path){return enabled && [...reserved].some(root=>root.startsWith(normalize(path)+"/"));}
  function selected(value){
    if(typeof value!=="string")return false;
    const original=normalize(value),resolved=resolvePath(value);
    if(!owns(original) && !owns(resolved))return false;
    if(original!==resolved || original.split("/").some(part=>[".","..",""].includes(part)))fail("EACCES");
    context();return original;
  }
  function target(path){
    const found=[...mounted].find(([root])=>under(path,root));
    if(!found || found[1].blocked)fail("ENOENT");
    const [root,mount]=found,relative=path.slice(root.length).replace(/^\//,"");
    if(mount.kind==="file" && relative)fail("ENOENT");
    return {id:mount.id,path:relative,role:mount.role};
  }
  function result(status,data){context();if(status<200||status>=300)fail((status===404?"ENOENT":status===403?"EACCES":data?.code || "SHARE_UNAVAILABLE"),data?.error || "Shared resource unavailable");return data;}
  async function exchange(operation,input){context();const response=await request("/api/shares",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json","X-Ignis-Context":scope.sessionId},body:JSON.stringify({operation,input:wire(input)})});return result(response.status,await response.json());}
  function exchangeSync(operation,input){context();const xhr=createXHR();xhr.open("POST","/api/shares",false);xhr.setRequestHeader("Content-Type","application/json");xhr.send(JSON.stringify({operation,input:wire(input)}));return result(xhr.status,JSON.parse(xhr.responseText));}
  function mountName(mount){
    const value=mount.localPath;
    if(typeof value!=="string" || !value || normalize(value)!==value || value.split("/").some(part=>!part || part===".." || part.startsWith(".")))fail("SHARE_UNAVAILABLE");
    return value;
  }
  function accept(snapshot,notify){
    context();
    const next=Object.create(null),map=new Map();maxBytes=snapshot.limits.maxFileBytes;
    for(const mount of snapshot.mounts){const name=mountName(mount);if(map.has(name))fail("SHARE_UNAVAILABLE","Shared resource names conflict");map.set(name,mount);reserved.add(name);
      if(mount.blocked){metadataCache.deleteSubtree(name);onNotice("A shared location conflicts with local content or its parent is unavailable. Choose another location in Shared, then reload.");continue;}
      for(const [relative,meta] of Object.entries(mount.tree)){const path=name+(relative?"/"+relative:"");next[path]=meta;}
    }
    // A path reused for a different grant must not inherit an old editor's save baseline.
    for(const [root,oldMount] of mounted)if(map.has(root) && map.get(root).id!==oldMount.id){
      for(const path of Object.keys(tree))if(under(path,root) && next[path]){
        state(path).blocked=true;if(notify)onRemoved(path);
      }
    }
    // Capture open editors before a downgrade can refresh them as read-only.
    for(const [root,oldMount] of mounted)if(oldMount.role==="editor" && map.get(root)?.role==="reader"){
      for(const path of Object.keys(tree))if(under(path,root) && tree[path].type==="file"){
        state(path).blocked=true;if(notify)onRemoved(path,"read-only");
      }
    }
    mounted=map;
    for(const path of Object.keys(tree).sort((a,b)=>b.length-a.length))if(!next[path]){
      metadataCache.delete(path);if(states.has(path))states.get(path).blocked=true;if(notify){onRemoved(path);watch._dispatch("rename",path);}
    }
    for(const [path,meta] of Object.entries(next).sort(([a],[b])=>a.length-b.length)){
      const previous=tree[path];metadataCache.set(path,meta);
      if(notify && (!previous || previous.mtime!==meta.mtime || previous.size!==meta.size))watch._dispatch(previous?"change":"rename",path);
    }
    outgoing=snapshot.outgoing || [];
    tree=next;for(const subscriber of subscribers)subscriber();
  }
  function configure(ordinary){
    scope={...currentContext()};
    enabled=true;
    try{accept(exchangeSync("mounts",{vault:scope.vault}),false);}catch(error){onNotice(error.message);throw error;}
    const safe={...ordinary};for(const [root,mount] of mounted)if(mount.blocked)for(const path of Object.keys(safe))if(under(path,root))delete safe[path];
    return {...safe,...tree};
  }
  async function refresh(){if(!enabled || refreshing)return;refreshing=true;try{accept(await exchange("mounts",{vault:scope.vault}),true);}catch(error){onNotice(error.message);}finally{refreshing=false;}}
  function start(){if(enabled&&!timer)timer=setInterval(refresh,15000);}
  function stop(){if(timer)clearInterval(timer);timer=null;for(const path of Object.keys(tree))metadataCache.delete(path);tree=Object.create(null);mounted.clear();outgoing=[];states.clear();reserved.clear();enabled=false;scope=null;}
  function stat(path){context();const value=metadataCache.toStat(path);if(!value)fail("ENOENT");return value;}
  function readdir(path){if(!stat(path).isDirectory())fail("ENOTDIR");return metadataCache.readdir(path).map(entry=>entry.name);}
  function state(path){if(!states.has(path))states.set(path,{etag:undefined,blocked:false,busy:false});return states.get(path);}
  function decode(file,encoding){if(file.kind!=="file")fail("EISDIR");const format=typeof encoding==="object"?encoding?.encoding:encoding;const content=bytes(file.content);if(!format)return content;if(!["utf8","utf-8"].includes(format))fail("EINVAL","Unsupported shared file encoding");return new TextDecoder().decode(content);}
  function inputBytes(data,encoding){const format=typeof encoding==="object"?encoding?.encoding:encoding;if(format && !["utf8","utf-8"].includes(format))fail("EINVAL");const value=typeof data==="string"?new TextEncoder().encode(data):data;if(!(value instanceof Uint8Array) || value.length>maxBytes)fail("SHARE_TOO_LARGE");return value;}
  function readAccepted(path,file,encoding){const value=state(path);if(value.etag===undefined)value.etag=file.etag;return decode(file,encoding);}
  async function read(path,encoding){return readAccepted(path,await exchange("read",target(path)),encoding);}
  function readSync(path,encoding){return readAccepted(path,exchangeSync("read",target(path)),encoding);}
  function writeStart(path,data,encoding){context();const destination=target(path);if(destination.role!=="editor")fail("EACCES","This shared resource is read-only");const value=state(path);if(value.blocked)fail("SHARE_CONFLICT","Shared saves paused; preserve your changes and reload");if(value.busy)fail("EBUSY");value.busy=true;return {destination,value,content:base64(inputBytes(data,encoding))};}
  function writeError(path,data,error){const value=state(path);value.blocked=true;try{onFailure({path,content:typeof data==="string"?data:base64(data),binary:typeof data!=="string",code:error.code,...scope});}catch{}throw error;}
  async function write(path,data,encoding){let operation;try{
    operation=writeStart(path,data,encoding);const {destination,value,content}=operation;
    if(value.etag===undefined)value.etag=metadataCache.has(path)?(await exchange("read",destination)).etag:null;
    const response=await exchange("write",{...destination,role:undefined,action:"write",etag:value.etag,content});value.etag=response.etag;
    await refresh();
  }catch(error){writeError(path,data,error);}finally{if(operation)operation.value.busy=false;}}
  function writeSync(path,data,encoding){let operation;try{
    operation=writeStart(path,data,encoding);const {destination,value,content}=operation;
    if(value.etag===undefined)value.etag=metadataCache.has(path)?exchangeSync("read",destination).etag:null;
    const response=exchangeSync("write",{...destination,role:undefined,action:"write",etag:value.etag,content});value.etag=response.etag;
    accept(exchangeSync("mounts",{vault:scope.vault}),true);
  }catch(error){writeError(path,data,error);}finally{if(operation)operation.value.busy=false;}}
  function mutationInput(method,path){const destination=target(path);if(!destination.path || destination.role!=="editor")fail("EACCES","Shared resource roots and read-only resources cannot be changed");return {...destination,role:undefined,action:method,etag:method==="mkdir"?null:stat(path).isDirectory()?"directory":state(path).etag};}
  async function mutate(method,path){const input=mutationInput(method,path);if(input.etag===undefined)input.etag=(await exchange("read",target(path))).etag;await exchange(method,input);states.delete(path);await refresh();}
  function mutateSync(method,path){const input=mutationInput(method,path);if(input.etag===undefined)input.etag=exchangeSync("read",target(path)).etag;exchangeSync(method,input);states.delete(path);accept(exchangeSync("mounts",{vault:scope.vault}),true);}
  function renameInput(path,newPath){
    context();const resolved=resolvePath(newPath),next=normalize(newPath);
    if(resolved!==next || !next || next.split("/").some(part=>!part || part==="." || part===".."))fail("EACCES");
    if(metadataCache.has(next))fail("EEXIST");
    for(const [key,value] of states)if(under(key,path) && (value.busy || value.blocked))fail("SHARE_CONFLICT","Save changes or reload before renaming this resource");
    const source=target(path);
    if(!source.path){
      if(owns(next))fail("EACCES");
      return {operation:"destination",input:{id:source.id,vault:scope.vault,localPath:next},next};
    }
    const destination=target(next);
    if(source.id!==destination.id || source.role!=="editor")fail("EACCES");
    return {operation:"rename",input:{id:source.id,path:source.path,to:destination.path,etag:stat(path).isDirectory()?undefined:state(path).etag},next};
  }
  function renamed(path,next){
    metadataCache.rename(path,next);
    for(const key of Object.keys(tree))if(under(key,path)){tree[next+key.slice(path.length)]=tree[key];delete tree[key];}
    for(const [key,value] of new Map(states))if(under(key,path)){states.set(next+key.slice(path.length),value);states.delete(key);}
    if(mounted.has(path)){mounted.set(next,{...mounted.get(path),localPath:next});mounted.delete(path);reserved.add(next);}
  }
  async function rename(path,next){
    const operation=renameInput(path,next);
    if(operation.operation==="rename" && operation.input.etag===undefined)operation.input.etag=(await exchange("read",target(path))).etag;
    await exchange(operation.operation,operation.input);renamed(path,operation.next);await refresh();
  }
  function renameSync(path,next){
    const operation=renameInput(path,next);
    if(operation.operation==="rename" && operation.input.etag===undefined)operation.input.etag=exchangeSync("read",target(path)).etag;
    exchangeSync(operation.operation,operation.input);renamed(path,operation.next);accept(exchangeSync("mounts",{vault:scope.vault}),true);
  }
  function access(path,mode=0){stat(path);if(mode&1 || ((mode&2) && (target(path).role!=="editor")))fail("EACCES");}
  function wrap(original,sync=false){const methods=new Map();return new Proxy(original,{get(object,name){const fn=object[name];if(typeof fn!=="function")return fn;if(methods.has(name))return methods.get(name);const wrapped=(...args)=>{
    const path=selected(args[0]),second=["rename","renameSync","copyFile","copyFileSync"].includes(name)?selected(args[1]):false;
    if(["rename","renameSync","rmdir","rmdirSync","rm","rmSync"].includes(name) && containsMount(args[0]))fail("ENOTSUP","Move shared resources out of this folder before moving or deleting it");
    if(!path&&!second)return fn.apply(object,args);
    const method=String(name).replace(/Sync$/,"");
    const run=()=>{
      if(method==="rename"){if(!path)fail("ENOTSUP");return sync?renameSync(path,args[1]):rename(path,args[1]);}
      if(second || ["copyFile","utimes","lutimes","chmod"].includes(method))fail("ENOTSUP","This operation is not supported on shared resources");
      if(method==="exists"){try{stat(path);return true;}catch(error){if(error.code==="ENOENT")return false;throw error;}}
      if(["stat","lstat"].includes(method))return stat(path);
      if(method==="readdir")return readdir(path);
      if(method==="access")return access(path,args[1]);
      if(method==="readFile")return sync?readSync(path,args[1]):read(path,args[1]);
      if(method==="writeFile")return sync?writeSync(path,args[1],args[2]):write(path,args[1],args[2]);
      if(method==="appendFile") {if(sync){const current=readSync(path);const append=inputBytes(args[1],args[2]);const joined=new Uint8Array(current.length+append.length);joined.set(current);joined.set(append,current.length);return writeSync(path,joined);}return read(path).then(current=>{const append=inputBytes(args[1],args[2]),joined=new Uint8Array(current.length+append.length);joined.set(current);joined.set(append,current.length);return write(path,joined);});}
      if(method==="mkdir") {if(args[1]?.recursive && metadataCache.get(path)?.type==="directory")return;return sync?mutateSync("mkdir",path):mutate("mkdir",path);}
      if(["unlink","rmdir","rm"].includes(method)){if(args[1]?.recursive)fail("ENOTSUP","Recursive removal of shared resources is not supported");return sync?mutateSync("remove",path):mutate("remove",path);}
      fail("ENOTSUP");
    };
    return sync?run():Promise.resolve().then(run);
  };methods.set(name,wrapped);return wrapped;}});}
  function resourceUrl(path){const selectedPath=selected(path);if(!selectedPath)return null;const destination=target(selectedPath);return "/api/shares/content?"+new URLSearchParams({id:destination.id,path:destination.path,context:scope.sessionId});}
  function installAdapter(app){
    const adapter=app?.vault?.adapter;
    if(!adapter?.getResourcePath)return;
    const original=adapter.getResourcePath.bind(adapter);
    adapter.getResourcePath=(path,...args)=>resourceUrl(path) || original(path,...args);
    // Repair attachments rendered before the runtime bridge became available.
    const prefix="/vault-files/"+encodeURIComponent(scope?.vault || "")+"/";
    for(const element of document.querySelectorAll("img[src],audio[src],video[src],source[src]")){
      try {const url=new URL(element.getAttribute("src"),location.origin);if(url.origin===location.origin && url.pathname.startsWith(prefix)){
        const replacement=resourceUrl(decodeURIComponent(url.pathname.slice(prefix.length)));if(replacement)element.setAttribute("src",replacement);
      }}catch{/* Unrelated or unsupported resource URL. */}
    }
  }
  function describe(path){
    const value=normalize(path),found=[...mounted].find(([root,mount])=>!mount.blocked&&under(value,root));
    if(found)return {direction:"incoming",role:found[1].role,owner:found[1].owner || "",root:found[0]};
    const sent=outgoing.find(item=>value===item.path);
    return sent?{direction:"outgoing",root:sent.path}:null;
  }
  return {configure,refresh,start,stop,owns,wrap,describe,subscribe(fn){subscribers.add(fn);return ()=>subscribers.delete(fn);},resourceUrl,installAdapter,assertOrdinary(path,resolved){if(owns(path)||owns(resolved))fail("ENOTSUP","File descriptors are not supported on shared resources");}};
}
