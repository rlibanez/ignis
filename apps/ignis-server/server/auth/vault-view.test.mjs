import {it,expect} from "vitest";
import {createRequire} from "node:module";
const {createVaultView}=createRequire(import.meta.url)("./vault-view");
const vault={id:"Own",name:"Own",uuid:"own-id",path:"/vaults/Own",platform:"linux",version:"1.14.4",trustPlugins:true,secret:"internal"};
const other={...vault,id:"Other",name:"Other",path:"/vaults/Other"};
it("includes paths only for authorized catalog entries and strips unknown metadata",()=>{
 const view=createVaultView({administrator:false,authorize:id=>id==="Own",uuid:()=>"own-id"});
 expect(view.list([vault,other])).toEqual([{id:"Own",name:"Own",path:"/vaults/Own",uuid:"own-id"}]);
 expect(view.info(vault)).toEqual({id:"Own",name:"Own",uuid:"own-id",path:"/",platform:"linux",version:"1.14.4",trustPlugins:true});
 expect(()=>view.info(other)).toThrow();
});
it("does not include shared plugins, server settings, unknown properties or shared etags",()=>{
 const view=createVaultView({administrator:false,authorize:id=>id==="Own",uuid:()=>"own-id"});
 const response={vault,vaultList:[vault,other],tree:{"note.md":{type:"file",size:1}},etag:"global",plugins:["secret-plugin"],virtualPlugins:[{source:"private-code"}],secret:"unknown",settings:{directFetchHosts:["internal.invalid"],devSuppressWriteFailures:true,credentials:"secret"},privateConfiguration:{}};
 const output=view.bootstrap(response);
 expect(output.plugins).toEqual([]);expect(output.virtualPlugins).toEqual([]);
 expect(output.settings.directFetchHosts).toEqual([]);expect(output.settings.devSuppressWriteFailures).toBe(false);
 expect(JSON.stringify(output)).not.toMatch(/secret|Other|global|internal.invalid|private-code/);
 expect(output.etag).not.toBe(response.etag);
 expect(view.bootstrap({...response,etag:"new-global"}).etag).toBe(output.etag);
 expect(response.vault.path).toBe("/vaults/Own");
});
it("rechecks permission on every projection and checks administrators too",()=>{
 let allowed=true;
 const view=createVaultView({administrator:false,authorize:()=>allowed,uuid:()=>"own-id"});
 expect(view.list([vault])).toHaveLength(1);allowed=false;
 expect(view.list([vault])).toEqual([]);expect(()=>view.bootstrap({vault})).toThrow();
 const admin=createVaultView({administrator:true,authorize:id=>id==="Own" && allowed,uuid:()=>"own-id"});
 expect(admin.list([vault,other])).toEqual([]); expect(()=>admin.info(vault)).toThrow();
 allowed=true; const response={vault,vaultList:[vault,other]};
 expect(admin.bootstrap(response).vaultList).toEqual([{id:"Own",name:"Own",path:"/vaults/Own",uuid:"own-id"}]);
 expect(()=>admin.info(other)).toThrow();
});

it("filters foreign vault references in server-plugin metadata for administrators",()=>{
 const view=createVaultView({administrator:true,authorize:id=>id==="Own",uuid:()=>"own-id"});
 const result=view.bootstrap({vault,vaultList:[vault,other],plugins:[{id:"sync",enabledVaults:["Own","Other"]}]});
 expect(result.plugins[0].enabledVaults).toEqual(["Own"]);
});
