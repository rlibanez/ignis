import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {createHash} from "node:crypto";
const hash=text=>createHash("sha256").update(text).digest("hex");
import WebSocket from "ws";
import { once } from "node:events";
const require = createRequire(import.meta.url);
const { openDatabase } = require("./database");
const { bootstrapAdmin } = require("./store");
const { hashPassword } = require("./password");

async function launch(root, env = {}) {
  const child = spawn(
    process.execPath,
    [path.resolve("apps/ignis-server/server/index.js")],
    {
      env: {
        ...process.env,
        PORT: "0",
        DATA_ROOT: path.join(root, "data"),
        VAULT_ROOT: path.join(root, "vaults"),
        OBSIDIAN_ASSETS_PATH: path.join(root, "assets"),
        IGNIS_PUBLIC_ORIGIN: "http://localhost:8080",
        IGNIS_ALLOW_HTTP_LOOPBACK: "true",
        IGNIS_TRUSTED_PROXIES: "[]",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Server startup timed out"));
    }, 8000);
    child.stdout.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/Server running on port (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code})`));
    });
  });
  return { child, ready, logs: () => log };
}
function request(port, route, jar = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method: options.method || "GET",
        headers: {
          host: "localhost:8080",
          origin: "http://localhost:8080",
          cookie: Object.entries(jar)
            .map(([k, v]) => `${k}=${v}`)
            .join("; "),
          "content-type": "application/json",
          ...(options.body ? {"content-length":Buffer.byteLength(JSON.stringify(options.body))}:{}),
          ...options.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          for (const cookie of res.headers["set-cookie"] || []) {
            const [k, v] = cookie.split(";")[0].split("=");
            jar[k] = v;
          }
          resolve({ status: res.statusCode, text, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}
async function stop(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill(signal);
  });
}

it('validates three independent real sessions across conflicts, downgrade, revoke, rename, deletion and restart',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ignis-multiuser-'));
 fs.mkdirSync(path.join(root,'vaults'));fs.mkdirSync(path.join(root,'assets'));fs.writeFileSync(path.join(root,'assets','index.html'),'<script src="app.js"></script>');
 const password='synthetic-multiuser-password-2026',db=openDatabase(path.join(root,'data'));
 bootstrapAdmin(db,'admin',await hashPassword(password));
 for(const login of ['alice','bob','carol']){
  db.prepare("INSERT INTO users(id,login,role,created_at) VALUES (?,?,'user',0)").run(login,login);
  db.prepare('INSERT INTO local_credentials SELECT ?,password_hash,updated_at FROM local_credentials LIMIT 1').run(login);
 }
 db.close();let server,port;const sockets=[];
 try{
  server=await launch(root);port=await server.ready;
  async function client(login){
   const jar={},challenge=JSON.parse((await request(port,'/api/auth/csrf',jar)).text).csrfToken;
   expect((await request(port,'/api/auth/login',jar,{method:'POST',headers:{'x-ignis-csrf':challenge},body:{login,password}})).status).toBe(200);
   const session=JSON.parse((await request(port,'/api/auth/session',jar)).text),csrf=JSON.parse((await request(port,'/api/auth/csrf',jar)).text).csrfToken;
   const call=(route,body,method=body?'POST':'GET')=>request(port,route,jar,{method,headers:{'x-ignis-context':session.sessionId,'x-ignis-csrf':csrf},...(body?{body}:{})});
   return {jar,context:session.sessionId,call,share:(operation,input)=>call('/api/shares',{operation,input})};
  }
  const alice=await client('alice'),bob=await client('bob'),carol=await client('carol');
  async function success(response){const r=await response;expect(r.status,r.text).toBe(200);return JSON.parse(r.text);}
  const a=(await success(alice.call('/api/vault/create',{name:'Alice'}))).uuid;
  const b=(await success(bob.call('/api/vault/create',{name:'Bob'}))).uuid;
  const c=(await success(carol.call('/api/vault/create',{name:'Carol'}))).uuid;
  // Whole-vault memberships are independent from resource grants and admin role.
  const admin=await client('admin');
  expect((await admin.call('/api/fs/readFile?vault='+a+'&path=private.md')).status).toBe(404);
  let membership=await success(alice.call('/api/vault/members?vault='+a));
  const member=async(role,expectedRole)=>{membership=await success(alice.call('/api/vault/members',{vault:a,login:'bob',role,expectedRole,revision:membership.revision}));};
  await member('editor',null);
  await success(alice.call('/api/fs/writeFile?vault='+a,{path:'private.md',content:'base',expectedHash:null}));
  const readPrivate=actor=>actor.call('/api/fs/readFile?vault='+a+'&path=private.md&encoding=utf8');
  expect((await readPrivate(alice)).text).toBe('base');expect((await readPrivate(bob)).text).toBe('base');
  // Generic plugin replacement is intentional, but cannot downgrade an explicit CAS.
  expect((await alice.call('/api/fs/writeFile?vault='+a,{path:'private.md',content:'plugin'})).status).toBe(200);
  expect((await bob.call('/api/fs/writeFile?vault='+a,{path:'private.md',content:'stale editor',expectedHash:hash('base')})).status).toBe(409);
  for(const expectedHash of ['*','',false,{}])expect((await alice.call('/api/fs/writeFile?vault='+a,{path:'private.md',content:'bad',expectedHash})).status).toBe(428);
  expect((await alice.call('/api/fs/writeFile?vault='+a,{path:'private.md',content:'wrong create',expectedHash:null})).status).toBe(409);
  expect((await readPrivate(alice)).text).toBe('plugin');
  await success(alice.call('/api/fs/writeFile?vault='+a,{path:'private.md',content:'base',expectedHash:hash('plugin')}));
  const ordinaryRace=await Promise.all([
    alice.call('/api/fs/writeFile?vault='+a,{path:'private.md',content:'alice edit',expectedHash:hash('base')}),
    bob.call('/api/fs/writeFile?vault='+a,{path:'private.md',content:'bob edit',expectedHash:hash('base')})]);
  expect(ordinaryRace.map(r=>r.status).sort()).toEqual([200,409]);
  const saved=(await readPrivate(alice)).text;
  expect(saved).toBe(ordinaryRace[0].status===200?'alice edit':'bob edit');
  await member('reader','editor');
  expect((await bob.call('/api/fs/writeFile?vault='+a,{path:'private.md',content:'forbidden'})).status).toBe(404);
  expect((await readPrivate(bob)).text).toBe(saved);
  const socket=new WebSocket(`ws://127.0.0.1:${port}/ws?vault=${a}&context=${bob.context}`,{headers:{host:'localhost:8080',origin:'http://localhost:8080',cookie:Object.entries(bob.jar).map(([k,v])=>`${k}=${v}`).join('; ')}});
  sockets.push(socket);await once(socket,'open',{signal:AbortSignal.timeout(3000)});
  const closed=once(socket,'close',{signal:AbortSignal.timeout(3000)});
  await member(null,'reader');await closed;
  expect((await readPrivate(bob)).status).toBe(404);
  expect((await readPrivate(admin)).status).toBe(404);
  // Exercise Obsidian's real local-trash mkdir/rename sequence as a normal owner.
  await success(alice.call('/api/fs/mkdir?vault='+a,{path:'.trash',recursive:true}));
  await success(alice.call('/api/fs/writeFile?vault='+a,{path:'Discard.md',content:'trash me',expectedHash:null}));
  await success(alice.call('/api/fs/rename?vault='+a,{oldPath:'Discard.md',newPath:'.trash/Discard.md'}));
  await success(alice.call('/api/fs/rename?vault='+a,{oldPath:'.trash/Discard.md',newPath:'Restored.md'}));
  await success(alice.call('/api/fs/mkdir?vault='+a,{path:'DiscardFolder',recursive:false}));
  await success(alice.call('/api/fs/writeFile?vault='+a,{path:'DiscardFolder/file.md',content:'shared trash',expectedHash:null}));
  const trashedShare=(await success(alice.share('create',{vault:a,path:'DiscardFolder',login:'carol',role:'editor'}))).id;
  await success(alice.call('/api/fs/rename?vault='+a,{oldPath:'DiscardFolder',newPath:'.trash/DiscardFolder'}));
  expect((await carol.share('read',{id:trashedShare,path:'file.md'})).status).toBe(404);
  expect((await alice.call('/api/fs/readFile?vault='+a+'&path=.trash/DiscardFolder/file.md')).text).toBe('shared trash');
  await success(alice.call('/api/fs/mkdir?vault='+a,{path:'Project',recursive:false}));
  await success(alice.call('/api/fs/writeFile?vault='+a,{path:'Project/note.md',content:'original',expectedHash:null}));
  const id=(await success(alice.share('create',{vault:a,path:'Project',login:'bob',role:'editor'}))).id;
  await success(alice.share('grant',{action:'grant',id,login:'carol',role:'editor',revision:1}));
  const receivedSource={id,vault:null,path:''},localCopy={id:null,vault:c,path:'CopiedProject'};
  await success(carol.share('copy',{from:receivedSource,to:localCopy}));
  expect((await carol.call('/api/fs/readFile?vault='+c+'&path=CopiedProject/note.md')).text).toBe('original');
  expect((await carol.share('copy',{from:receivedSource,to:localCopy})).status).toBe(409);
  await success(carol.share('copy',{from:{id:null,vault:c,path:'CopiedProject/note.md'},to:{id,vault:null,path:'CopiedBack.md'}}));
  expect((await alice.call('/api/fs/readFile?vault='+a+'&path=Project/CopiedBack.md')).text).toBe('original');
  expect((await admin.share('copy',{from:receivedSource,to:{id:null,vault:c,path:'Stolen'}})).status).toBe(404);
  expect((await request(port,'/api/shares',carol.jar,{method:'POST',body:{operation:'copy',input:{from:receivedSource,to:{...localCopy,path:'NoCsrf'}}}})).status).toBe(403);
  await success(bob.share('destination',{id,vault:b,localPath:'Received'}));await success(carol.share('destination',{id,vault:c,localPath:'Team'}));
  const rb=await success(bob.share('read',{id,path:'note.md'})),rc=await success(carol.share('read',{id,path:'note.md'}));expect(rb.etag).toBe(rc.etag);
  const write=(actor,etag,text)=>actor.share('write',{action:'write',id,path:'note.md',etag,content:Buffer.from(text).toString('base64')});
  const race=await Promise.all([write(bob,rb.etag,'bob wins?'),write(carol,rc.etag,'carol wins?')]);expect(race.map(r=>r.status).sort()).toEqual([200,409]);
  const beforeMixed=await success(bob.share('read',{id,path:'note.md'}));
  const mixed=await Promise.all([
    alice.call('/api/fs/writeFile?vault='+a,{path:'Project/note.md',content:'owner edit',expectedHash:beforeMixed.etag}),
    write(bob,beforeMixed.etag,'recipient edit')]);
  expect(mixed.map(r=>r.status).sort()).toEqual([200,409]);
  const latest=await success(bob.share('read',{id,path:'note.md'}));
  // Acknowledged bytes, aliases and sessions survive an abrupt process death.
  await stop(server.child,"SIGKILL");server=await launch(root);port=await server.ready;
  expect((await success(bob.share('read',{id,path:'note.md'}))).content).toBe(latest.content);
  expect((await alice.call('/api/fs/writeFile?vault='+a,{path:'Project/note.md',content:'stale after restart',expectedHash:beforeMixed.etag})).status).toBe(409);
  expect((await success(bob.share('mounts',{vault:b}))).mounts[0].localPath).toBe('Received');
  expect((await success(carol.share('mounts',{vault:c}))).mounts[0].localPath).toBe('Team');
  await success(alice.share('grant',{action:'grant',id,login:'bob',role:'reader',revision:2}));
  expect((await write(bob,latest.etag,'forbidden')).status).toBe(404);
  expect((await success(bob.share('mounts',{vault:b}))).mounts[0].role).toBe('reader');
  expect((await success(carol.share('read',{id,path:'note.md'}))).content).toBe(latest.content);
  // Both the resource recipient and the owner can move within the same share.
  await success(alice.call('/api/fs/mkdir?vault='+a,{path:'Project/Sub',recursive:false}));
  await success(carol.share('rename',{id,path:'note.md',to:'Sub/note.md',etag:latest.etag}));
  expect((await success(carol.share('read',{id,path:'Sub/note.md'}))).content).toBe(latest.content);
  await success(alice.call('/api/fs/rename?vault='+a,{oldPath:'Project/Sub/note.md',newPath:'Project/note.md'}));
  expect((await success(bob.share('read',{id,path:'note.md'}))).content).toBe(latest.content);
  expect((await alice.call('/api/fs/rename?vault='+a,{oldPath:'Project/note.md',newPath:'outside.md'})).status).toBe(409);
  await success(alice.call('/api/fs/rename?vault='+a,{oldPath:'Project',newPath:'Renamed'}));
  expect((await success(bob.share('mounts',{vault:b}))).mounts[0].localPath).toBe('Received');
  expect((await success(carol.share('read',{id,path:'note.md'}))).content).toBe(latest.content);
  await success(alice.call('/api/vault/rename',{vault:a,name:'Alice renamed'}));
  expect((await success(bob.share('read',{id,path:'note.md'}))).content).toBe(latest.content);
  const catalog=await success(alice.call('/api/shares')),revision=catalog.resources.find(r=>r.id===id).revision;
  await success(alice.share('grant',{action:'grant',id,login:'bob',role:null,revision}));
  expect((await bob.share('read',{id,path:'note.md'})).status).toBe(404);
  expect((await success(bob.share('mounts',{vault:b}))).mounts).toEqual([]);
  expect((await success(carol.share('read',{id,path:'note.md'}))).content).toBe(latest.content);
  await success(alice.call('/api/vault/remove?vault='+a,undefined,'DELETE'));
  expect((await carol.share('read',{id,path:'note.md'})).status).toBe(404);
  expect((await write(carol,latest.etag,'must not resurrect')).status).toBe(404);
  expect((await success(carol.share('mounts',{vault:c}))).mounts).toEqual([]);
  expect(fs.existsSync(path.join(root,'vaults','Alice renamed'))).toBe(false);
  await stop(server.child);server=await launch(root);port=await server.ready;
  expect((await success(bob.share('mounts',{vault:b}))).mounts).toEqual([]);
  expect((await success(carol.share('mounts',{vault:c}))).mounts).toEqual([]);
 }finally{for(const socket of sockets)socket.terminate();if(server)await stop(server.child);fs.rmSync(root,{recursive:true,force:true});}
},45000);
