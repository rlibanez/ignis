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

it("routes grant batches and preserves conflict responses",async()=>{
 const limits=readResourceShareLimits({});let calls=0;
 const app=express();app.use(createResourceSharesRouter({limits,grants:(_token,input)=>{calls++;if(input.revision===2)throw Object.assign(new Error(),{code:"SHARE_CONFLICT"});return {ok:true};}}));
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");
 const post=input=>fetch(`http://127.0.0.1:${server.address().port}/api/shares`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operation:"grants",input})});
 try{
  const input={id:"resource",revision:1,changes:[{login:"recipient",role:"reader"}]};
  expect((await post(input)).status).toBe(200);
  expect((await post({...input,unexpected:true})).status).toBe(400);
  expect((await post({...input,revision:2})).status).toBe(409);
  expect(calls).toBe(2);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
