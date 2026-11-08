import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {WebSocket} from 'ws';
export async function browser({mobile=false}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-e2e-chrome-'));
 const process=spawn(globalThis.process.env.IGNIS_CHROME_PATH || '/opt/google/chrome/chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0','--user-data-dir='+directory,'about:blank'],{stdio:'ignore'});
 let socket,id=0;const pending=new Map(),errors=[];
 const close=async()=>{socket?.close();process.kill('SIGTERM');await Promise.race([new Promise(r=>process.once('exit',r)),new Promise(r=>setTimeout(r,1000))]);if(process.exitCode===null)process.kill('SIGKILL');fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});};
 try{
  let port;
  for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(directory,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{}await new Promise(r=>setTimeout(r,50));}
  if(!port)throw Error('Chrome startup timed out');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await new Promise(r=>socket.once('open',r));
  socket.on('message',raw=>{const data=JSON.parse(raw);if(data.id){pending.get(data.id)?.(data);pending.delete(data.id);}if(data.method==='Network.responseReceived' && data.params.response.status>=400){const url=new URL(data.params.response.url);errors.push({path:url.pathname,file:url.searchParams.get('path'),status:data.params.response.status});}if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const current=++id;const timer=setTimeout(()=>{pending.delete(current);reject(Error('CDP command timed out: '+method));},15000);pending.set(current,data=>{clearTimeout(timer);if(data.error)reject(Error(data.error.message));else resolve(data.result);});socket.send(JSON.stringify({id:current,method,params}));});
  const run=async expression=>{const data=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(data.exceptionDetails)throw Error(data.exceptionDetails.exception?.description || data.exceptionDetails.text);return data.result.value;};
  const wait=async(expression,label,timeout=30000)=>{const until=Date.now()+timeout;while(Date.now()<until){if(await run(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timed out: '+label);};
  await call('Network.enable');await call('Runtime.enable');await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  if(mobile)await call('Emulation.setTouchEmulationEnabled',{enabled:true});
  if(mobile)await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  return {call,run,wait,errors,close};
 }catch(error){await close();throw error;}
}
