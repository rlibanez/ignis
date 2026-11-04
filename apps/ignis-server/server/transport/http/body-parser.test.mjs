import {it, expect} from 'vitest';
import {createRequire} from 'node:module';
import http from 'node:http';
import {gzipSync, deflateSync} from 'node:zlib';
const require = createRequire(import.meta.url);
const express = require('express');
const {createBodyParser} = require('./body-parser');

async function fixture(run) {
  let limit = 128, handled = 0;
  const settings = {get:()=>limit, MAX_BODY_BACKSTOP:512};
  const app = express();
  app.use(createBodyParser({settings,incomingShare:{maxMiB:1}}));
  app.post(['/api/fs/appendFile','/api/fs/writeFile'],(req,res)=>{
    handled++;
    res.json({bytes:Buffer.isBuffer(req.body.content)?req.body.content.length:Buffer.byteLength(req.body.content)});
  });
  app.use((error,req,res,next)=>res.status(error.status || 500).json({error:'Request failed'}));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const send = (body,{chunked=false,encoding,path='/api/fs/appendFile',binary=false}={}) => new Promise((resolve,reject)=>{
    const headers = {'Content-Type':binary?'application/octet-stream':'application/json'};
    if (!chunked) headers['Content-Length'] = body.length;
    if (encoding) headers['Content-Encoding'] = encoding;
    if(binary)headers['X-Ignis-Content-Version']='new';
    const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'POST',headers},res=>{
      let text='';res.on('data',chunk=>text+=chunk);
      res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
      res.on('error',reject);
    });
    req.on('error',reject);
    req.write(body.subarray(0,Math.max(1,body.length>>1)));
    req.end(body.subarray(Math.max(1,body.length>>1)));
  });
  try {await run({send,setLimit:value=>{limit=value;},handled:()=>handled});}
  finally {await new Promise(resolve=>server.close(resolve));}
}
const json = n => Buffer.from(JSON.stringify({content:'a'.repeat(n)}));
for (const chunked of [false,true]) {
  for (const encoding of [undefined,'gzip','deflate']) {
    it(`counts decoded JSON bytes (${chunked?'chunked':'Content-Length'}, ${encoding || 'identity'})`,async()=>fixture(async({send,handled})=>{
      const encode = body => encoding==='gzip'?gzipSync(body):encoding==='deflate'?deflateSync(body):body;
      expect((await send(encode(json(50)),{chunked,encoding})).status).toBe(200);
      expect((await send(encode(json(200)),{chunked,encoding})).status).toBe(413);
      expect(handled()).toBe(1);
    }));
  }
}
it('updates the effective JSON limit without restarting and retains the hard ceiling',async()=>fixture(async({send,setLimit})=>{
  expect((await send(json(200))).status).toBe(413);
  setLimit(300);expect((await send(json(200))).status).toBe(200);
  setLimit(64);expect((await send(json(80),{chunked:true})).status).toBe(413);
  setLimit(1024);expect((await send(json(600),{chunked:true})).status).toBe(413);
}));
it('does not apply the Android exception to JSON writes, including trailing slash',async()=>fixture(async({send})=>{
  for(const path of ['/api/fs/writeFile','/api/fs/writeFile/'])
    expect((await send(json(200),{path,chunked:true})).status).toBe(413);
}));
it('keeps binary uploads independent of the JSON limit and bounds decoded bytes',async()=>fixture(async({send,handled})=>{
  for(const path of ['/api/fs/writeFile?path=file.bin','/api/fs/writeFile/?path=file.bin']) {
    const options={path,binary:true,chunked:true};
    expect(await send(Buffer.alloc(256),options)).toEqual({status:200,body:{bytes:256}});
    expect((await send(Buffer.alloc(1024*1024+1),options)).status).toBe(413);
    expect((await send(gzipSync(Buffer.alloc(1024*1024+1)),{...options,encoding:'gzip'})).status).toBe(413);
  }
  expect(handled()).toBe(2);
}));

it('accepts the exact JSON limit and rejects the next byte',async()=>fixture(async({send})=>{
  const exact=Buffer.from(JSON.stringify({content:'a'.repeat(114)}));
  expect(exact.length).toBe(128);
  for(const chunked of [false,true]) {
    expect((await send(exact,{chunked})).status).toBe(200);
    expect((await send(Buffer.concat([exact,Buffer.from(' ')]),{chunked})).status).toBe(413);
  }
}));
