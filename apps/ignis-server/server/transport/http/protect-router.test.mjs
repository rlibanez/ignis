import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),express=require('express');
const {protectRouter}=require('./protect-router');
it('forwards synchronous and asynchronous failures, including nested routers, without duplicate wrapping',async()=>{
 const router=express.Router(),nested=express.Router();
 router.get('/sync',()=>{throw Error('sync');});
 nested.get('/async',async()=>{await Promise.resolve();throw Error('async');});
 router.use('/nested',nested);
 protectRouter(router);const wrapped=nested.stack[0].route.stack[0].handle;
 protectRouter(router);expect(nested.stack[0].route.stack[0].handle).toBe(wrapped);
 const errors=[];
 await router.stack[0].route.stack[0].handle({}, {},error=>errors.push(error.message));
 await wrapped({}, {},error=>errors.push(error.message));
 expect(errors).toEqual(['sync','async']);
});
it('returns a controlled error and continues serving requests after an async rejection',async()=>{
 const app=express(),router=express.Router();
 router.get('/fail',async()=>{await Promise.resolve();throw Error('private details');});
 router.get('/health',(req,res)=>res.json({ok:true}));
 app.use(protectRouter(router));
 app.use((error,req,res,next)=>res.status(500).json({error:'Request failed'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try {
  const base='http://127.0.0.1:'+server.address().port;
  const failed=await fetch(base+'/fail');expect(failed.status).toBe(500);
  expect(await failed.json()).toEqual({error:'Request failed'});
  expect(await(await fetch(base+'/health')).json()).toEqual({ok:true});
 }finally{await new Promise(resolve=>server.close(resolve));}
});
