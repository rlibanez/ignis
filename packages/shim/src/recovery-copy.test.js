import {it,expect,vi} from 'vitest';
import {recoveryClient,recoveryFolders} from './recovery-copy.js';
it('creates a new file with a null precondition and the original session context',async()=>{
 const scope={sessionId:'session',vault:'source'},request=vi.fn(async()=>({ok:true,json:async()=>({ok:true})}));
 await recoveryClient(scope,()=>scope,request).save('destination','Folder/note.md','draft ñ');
 const [url,options]=request.mock.calls[0];expect(url).toBe('/api/fs/writeFile?vault=destination');
 expect(options.headers['X-Ignis-Context']).toBe('session');
 expect(JSON.parse(options.body)).toEqual({path:'Folder/note.md',content:'draft ñ',encoding:'utf8',expectedHash:null});
});
it('does not retry collisions or permission failures',async()=>{
 for(const status of [409,403,401]){
  const scope={sessionId:'s',vault:'v'},request=vi.fn(async()=>({ok:false,status}));
  await expect(recoveryClient(scope,()=>scope,request).save('v','note.md','draft')).rejects.toThrow();expect(request).toHaveBeenCalledTimes(1);
 }
});
it('rejects changed contexts before requests and after responses',async()=>{
 const scope={sessionId:'s',vault:'v'},current={...scope};
 const request=vi.fn(async()=>{current.sessionId='other';return {ok:true,json:async()=>[]};});
 const client=recoveryClient(scope,()=>current,request);
 await expect(client.list()).rejects.toThrow();await expect(client.save('v','note.md','secret')).rejects.toThrow();expect(request).toHaveBeenCalledTimes(1);
});

it('builds separate vault roots and excludes files and hidden configuration from the folder picker',()=>{
 const folders=recoveryFolders([{uuid:'a',name:'A'},{uuid:'b',name:'B'}],{a:{Docs:{type:'directory'},'note.md':{type:'file'},'.obsidian':{type:'directory'}},b:{Docs:{type:'directory'}}});
 expect(folders.map(f=>f.path)).toEqual(['a','a/Docs','b','b/Docs']);
});
