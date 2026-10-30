import {it,expect} from "vitest";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {readResourceShareLimits}=require("./resource-share-limits");
const {readAuthConfig}=require("./http-policy");
it("defaults to 8 MiB and includes Base64 expansion plus JSON overhead",()=>{
 const limits=readResourceShareLimits({});expect(limits.maxFileMiB).toBe(8);expect(limits.maxFileBytes).toBe(8388608);expect(limits.maxRequestBytes).toBe(Math.ceil(8388608/3)*4+65536);
});
it.each(["1","32","128"])("accepts %s MiB through startup configuration",value=>{
 const config=readAuthConfig({IGNIS_PUBLIC_ORIGIN:"https://ignis.example",IGNIS_SHARED_RESOURCE_MAX_FILE_MIB:value});expect(config.sharedResourceLimits.maxFileBytes).toBe(Number(value)*1048576);
});
it.each(["","0","129","-1","+8","08","1.5"," 8","8 ","8MiB","Infinity","1e2",true,8])("rejects invalid configuration %s",value=>{
 expect(()=>readAuthConfig({IGNIS_PUBLIC_ORIGIN:"https://ignis.example",IGNIS_SHARED_RESOURCE_MAX_FILE_MIB:value})).toThrow(/IGNIS_SHARED_RESOURCE_MAX_FILE_MIB/);
});
