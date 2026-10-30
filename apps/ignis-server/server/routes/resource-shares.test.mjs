import {it,expect} from "vitest";
import {createRequire} from "node:module";
import {once} from "node:events";
const require=createRequire(import.meta.url);
const express=require("express");
const {createResourceSharesRouter}=require("./resource-shares");
const {readResourceShareLimits}=require("../auth/resource-share-limits");
it("sizes the JSON parser from the configured limit including Base64 overhead",async()=>{
 const limits=readResourceShareLimits({IGNIS_SHARED_RESOURCE_MAX_FILE_MIB:"1"});
 const app=express();app.use(createResourceSharesRouter({limits,mutate:()=>({ok:true}),read:()=>{throw Object.assign(new Error("too large"),{code:"SHARE_TOO_LARGE"});}}));
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 const url=`http://127.0.0.1:${server.address().port}/api/shares`;
 const post=body=>fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
 try{
 const body={operation:"write",input:{action:"write",id:"synthetic",path:"file",etag:null,content:Buffer.alloc(limits.maxFileBytes).toString("base64")}};
 expect((await post(body)).status).toBe(200);
 body.input.content="A".repeat(limits.maxRequestBytes);expect((await post(body)).status).toBe(413);
 const error=await post({operation:"read",input:{id:"synthetic",path:""}});expect(error.status).toBe(413);expect((await error.json()).error).toContain("1 MiB");
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
