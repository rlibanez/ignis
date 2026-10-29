import {it,expect} from "vitest";
import {createRequire} from "node:module";
const {createVaultView}=createRequire(import.meta.url)("./vault-view");
const vault={id:"Own",name:"Own",uuid:"own-id",path:"/vaults/Own",platform:"linux",version:"1.14.4",trustPlugins:true,secret:"internal"};
const other={...vault,id:"Other",name:"Other"};
it("filters catalog and strips physical paths and unknown metadata for normal accounts",()=>{
 const view=createVaultView({administrator:false,authorize:id=>id==="Own",uuid:()=>"own-id"});
 expect(view.list([vault,other])).toEqual([{id:"Own",name:"Own",uuid:"own-id"}]);
 expect(view.info(vault)).toEqual({id:"Own",name:"Own",uuid:"own-id",path:"/",platform:"linux",version:"1.14.4",trustPlugins:false});
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
it("rechecks permission on every projection and preserves administrator behavior",()=>{
 let allowed=true;
 const view=createVaultView({administrator:false,authorize:()=>allowed,uuid:()=>"own-id"});
 expect(view.list([vault])).toHaveLength(1);allowed=false;
 expect(view.list([vault])).toEqual([]);expect(()=>view.bootstrap({vault})).toThrow();
 const admin=createVaultView({administrator:true});const response={vault};
 expect(admin.bootstrap(response)).toBe(response);expect(admin.info(vault)).toBe(vault);
});
