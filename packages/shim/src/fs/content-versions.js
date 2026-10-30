import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
export const contentHash = value => bytesToHex(sha256(typeof value === "string" ? new TextEncoder().encode(value) : value));
const normalize = path => path.replace(/\\/g,"/").replace(/^\/+/,"");
const under = (path,root) => path===root || path.startsWith(root+"/");
const fail = () => {throw Object.assign(new Error("Saving is paused. Download your changes before reloading."),{code:"CONTENT_CONFLICT"});};
// A first-read baseline survives cache eviction and indexing. Only our own
// acknowledged save advances it; a new server read never rebases an old editor.
export function createContentVersions(context, onFailure=()=>{}) {
  let scope;const entries=new Map();
  function active(){const next=context();const key=JSON.stringify(next);if(key!==scope){entries.clear();scope=key;}return {...next};}
  function selected(path){active();path=normalize(path);return path && !path.split("/").some(part=>part.startsWith(".")) ? path : null;}
  function remember(path,content){path=selected(path);if(path && !entries.has(path))entries.set(path,{etag:contentHash(content),blocked:false,busy:false});}
  function prepare(path,cached=null){path=selected(path);if(!path || entries.has(path))return;if(cached!==null && cached!==undefined)remember(path,cached);else entries.set(path,{etag:null,blocked:false,busy:false});}
  function begin(path){path=selected(path);if(!path)return null;prepare(path);const state=entries.get(path);if(state.blocked || state.busy)fail();state.busy=true;return {path,state,scope,context:active(),expectedHash:state.etag};}
  function complete(operation,etag){if(!operation)return;active();if(scope!==operation.scope)fail();if(!/^[a-f0-9]{64}$/.test(etag || ""))fail();operation.state.etag=etag;operation.state.busy=false;}
  function rejected(path,data,error,operation){
    const current=active();path=selected(path);
    if(!path || (operation && operation.scope!==scope))throw error;
    prepare(path);const state=entries.get(path);state.blocked=true;state.busy=false;
    const binary=typeof data!=="string";
    let content=data;if(binary){let raw="";for(let i=0;i<data.length;i+=8192)raw+=String.fromCharCode(...data.subarray(i,i+8192));content=btoa(raw);}
    if(error.code!=="AUTH_CONTEXT_CHANGED"){try{onFailure({path,content,binary,...current,code:error.code});}catch{/* Recovery UI must not turn a terminal failure into a retry. */}}
    if(!["CONTENT_CONFLICT","CONTENT_WRITE_UNCERTAIN","AUTH_CONTEXT_CHANGED"].includes(error.code))error.code="CONTENT_WRITE_UNCERTAIN";
    throw error;
  }
  function moved(oldPath,newPath){active();oldPath=normalize(oldPath);newPath=normalize(newPath);const moving=Array.from(entries).filter(([p])=>under(p,oldPath));for(const [p,value] of moving){entries.set(newPath+p.slice(oldPath.length),{...value});value.blocked=true;}}
  function removed(path){active();path=normalize(path);for(const key of entries.keys())if(under(key,path))entries.delete(key);}
  return {remember,prepare,begin,complete,rejected,moved,removed};
}
