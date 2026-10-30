import {it,expect,vi,afterEach} from 'vitest';
import {installEditorSaves} from './editor-saves.js';
import {contentHash} from './fs/content-versions.js';
afterEach(()=>vi.useRealTimers());
function fixture() {
 let stored='base'; const scope={sessionId:'s',vault:'v'},recover=vi.fn();
 const adapter={queue:fn=>Promise.resolve().then(fn),write:vi.fn(async(path,data)=>{stored=data;}),reconcileInternalFile:vi.fn(async()=>{})};
 const pluginWrite=adapter.write;
 const app={vault:{adapter,modify:async(file,data,options)=>adapter.write(file.path,data,options)},workspace:{iterateAllLeaves:fn=>fn({view}),on:vi.fn()}};
 class TextFileView {constructor(){this.app=app;this.file={path:'note.md'};this.lastSavedData='base';this.text='draft';this.dirty=true;this.saving=false;this.saveAgain=false;}getViewData(){return this.text;}clear(){this.text='';}register(){}onload(){}save(){}}
 const view=new TextFileView();
 const write=vi.fn(async(path,data,etag,check)=>{check();if(etag!==contentHash(stored))throw Object.assign(new Error('Conflict'),{code:'CONTENT_CONFLICT'});stored=data;});
 const controller=installEditorSaves({TextFileView},app,write,()=>scope,recover);
 return {controller,view,app,adapter,write,pluginWrite,scope,recover,stored:()=>stored,TextFileView};
}
it('protects native editor saves while allowing plugin replacement without a preceding read',async()=>{
 const f=fixture();await f.app.vault.modify(f.view.file,'plugin replacement');
 expect(f.pluginWrite).toHaveBeenCalledTimes(1);expect(f.write).not.toHaveBeenCalled();
 await expect(f.view.save()).rejects.toMatchObject({code:'CONTENT_CONFLICT'});
 expect(f.stored()).toBe('plugin replacement');expect(f.recover).toHaveBeenCalledWith(expect.objectContaining({content:'draft'}));
 await f.app.vault.modify(f.view.file,'another intentional replacement');expect(f.stored()).toBe('another intentional replacement');
});
it('uses each view baseline, including a legitimate remote refresh, not a path-wide first read',async()=>{
 const f=fixture();await f.app.vault.modify(f.view.file,'remote');f.view.lastSavedData='remote';
 await f.view.save();expect(f.write).toHaveBeenCalledWith('note.md','draft',contentHash('remote'),expect.any(Function));
 expect(f.stored()).toBe('draft');f.view.text='next';await f.view.save();expect(f.stored()).toBe('next');
});
it('rejects two independent views saving the same baseline',async()=>{
 const f=fixture(),second=new f.TextFileView();second.onload();second.text='other';
 const result=await Promise.allSettled([f.view.save(),second.save()]);expect(result.map(x=>x.status).sort()).toEqual(['fulfilled','rejected']);
 expect(f.stored()).toBe('draft');
});
it('does not lend editor intent to a plugin while the adapter queue waits',async()=>{
 const f=fixture();let release;f.adapter.queue=fn=>new Promise(r=>release=()=>r(fn()));
 const saving=f.view.save();await f.app.vault.modify(f.view.file,'plugin');release();
 await expect(saving).rejects.toMatchObject({code:'CONTENT_CONFLICT'});expect(f.pluginWrite).toHaveBeenCalledTimes(1);
});
it.each(['sessionId','vault'])('rejects queued saves after %s changes without exposing recovery to the new context',async field=>{
 const f=fixture();let release;f.adapter.queue=fn=>new Promise(r=>release=()=>r(Promise.resolve().then(fn)));
 const saving=f.view.save();f.scope[field]='other';release();await expect(saving).rejects.toMatchObject({code:'AUTH_CONTEXT_CHANGED'});
 expect(f.write).not.toHaveBeenCalled();expect(f.recover).not.toHaveBeenCalled();
});
it('retains the draft and never retries a lost response, including unload and debounce',async()=>{
 vi.useFakeTimers();const f=fixture();f.write.mockRejectedValue(new Error('response lost'));
 await expect(f.view.save(true)).rejects.toThrow();expect(f.view.text).toBe('draft');
 f.view.requestSave();await vi.advanceTimersByTimeAsync(2100);await expect(f.view.save()).rejects.toThrow();
 expect(f.write).toHaveBeenCalledTimes(1);expect(f.view.lastSavedData).toBe('base');
});
it('replaces constructor-bound debounce for already-open views and clears only after acknowledgement',async()=>{
 vi.useFakeTimers();const f=fixture();f.view.requestSave();await vi.advanceTimersByTimeAsync(2100);expect(f.stored()).toBe('draft');
 f.view.text='last';await f.view.save(true);expect(f.stored()).toBe('last');expect(f.view.text).toBe('');
});
it('does not silently fall back to unconditional write for an invalid baseline or a renamed queued file',async()=>{
 const f=fixture();f.view.lastSavedData=undefined;await expect(f.view.save()).rejects.toThrow();expect(f.pluginWrite).not.toHaveBeenCalled();
 const g=fixture();let release;g.adapter.queue=fn=>new Promise(r=>release=()=>r(Promise.resolve().then(fn)));
 const saving=g.view.save();g.view.file.path='other.md';release();await expect(saving).rejects.toThrow();expect(g.write).not.toHaveBeenCalled();
});

it('exposes pending and failed drafts to session locking/logout recovery, but not another session',async()=>{
 const f=fixture();let release;f.adapter.queue=fn=>new Promise(r=>release=()=>r(Promise.resolve().then(fn)));
 const saving=f.view.save();expect(f.controller.snapshotPending()).toEqual([{path:'note.md',data:'draft',encoding:'utf8'}]);
 release();await saving;expect(f.controller.snapshotPending()).toEqual([]);
 f.view.text='later';f.write.mockRejectedValue(new Error('lost'));const lost=f.view.save();release();await expect(lost).rejects.toThrow();
 expect(f.controller.snapshotPending()[0].data).toBe('later');f.scope.sessionId=null;expect(f.controller.snapshotPending()).toHaveLength(1);
 f.scope.sessionId='new';expect(f.controller.snapshotPending()).toEqual([]);
});

it('does not block a different note in the same view or discard the earlier recovery draft',async()=>{
 const f=fixture();f.write.mockRejectedValueOnce(new Error('lost'));
 await expect(f.view.save()).rejects.toThrow();
 f.view.file={path:'other.md'};f.view.lastSavedData='base';f.view.text='other note';
 await f.view.save();expect(f.stored()).toBe('other note');
 expect(f.controller.snapshotPending()).toEqual([{path:'note.md',data:'draft',encoding:'utf8'}]);
});
