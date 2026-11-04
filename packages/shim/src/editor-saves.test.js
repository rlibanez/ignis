import {it,expect,vi,afterEach} from 'vitest';
import {installEditorSaves} from './integration/obsidian/editor-saves.js';
import {contentHash} from './fs/content-versions.js';
afterEach(()=>vi.useRealTimers());
function fixture() {
 let stored='base'; const scope={sessionId:'s',vault:'v'},recover=vi.fn();
 const adapter={queue:fn=>Promise.resolve().then(fn),write:vi.fn(async(path,data)=>{stored=data;}),reconcileInternalFile:vi.fn(async()=>{})};
 const pluginWrite=adapter.write;
 const app={vault:{adapter,modify:async(file,data,options)=>adapter.write(file.path,data,options)},workspace:{iterateAllLeaves:fn=>fn({view}),on:vi.fn()}};
 class TextFileView {constructor(){this.app=app;this.file={path:'note.md'};this.lastSavedData='base';this.text='draft';this.dirty=true;this.saving=false;this.saveAgain=false;}getViewData(){return this.text;}setViewData(text){this.text=text;}clear(){this.text='';}register(){}onload(){}save(){}}
 const view=new TextFileView();
 const write=vi.fn(async(path,data,etag,check)=>{check();if(etag!==contentHash(stored))throw Object.assign(new Error('Conflict'),{code:'CONTENT_CONFLICT'});stored=data;});
 const controller=installEditorSaves({TextFileView},app,write,()=>scope,recover,{version:"1.14.4"});
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

it('restores the read-only baseline without writing and rejects stale restoration',async()=>{
 const f=fixture();f.write.mockRejectedValue(Object.assign(new Error('Read only'),{code:'EACCES'}));
 await expect(f.view.save()).rejects.toThrow();const event=f.recover.mock.calls.at(-1)[0];
 f.view.text='new draft';expect(()=>event.restoreOriginal()).toThrow();
 f.view.text='draft';event.restoreOriginal();expect(f.view.text).toBe('base');expect(f.view.dirty).toBe(false);
 expect(f.write).toHaveBeenCalledTimes(1);expect(event.content).toBe('draft');
 f.scope.sessionId='other';expect(()=>event.restoreOriginal()).toThrow();
});

it('reads the latest editor text for recovery actions before the next debounced save',async()=>{
 const f=fixture();f.write.mockRejectedValue(Object.assign(new Error('Read only'),{code:'EACCES'}));
 f.view.text='SIgo ten1\n2\n3';await expect(f.view.save()).rejects.toThrow();
 const event=f.recover.mock.calls.at(-1)[0];f.view.text='1\n2\n3';
 expect(event.currentContent()).toBe('1\n2\n3');expect(f.stored()).toBe('base');
 f.view.file={path:'another.md'};expect(()=>event.currentContent()).toThrow();
 f.view.file={path:'note.md'};f.scope.sessionId='changed';expect(()=>event.currentContent()).toThrow();
});


it('allows native unload after a denied write while retaining an independent scoped draft',async()=>{
 const f=fixture();f.write.mockRejectedValueOnce(Object.assign(new Error('Read only'),{code:'EACCES'}));
 await expect(f.view.save()).rejects.toMatchObject({code:'EACCES'});
 f.view.text='latest\ndraft';await expect(f.view.save(true)).resolves.toBeUndefined();
 const event=f.recover.mock.calls.at(-1)[0];
 expect(event.restoreOriginal).toBeTypeOf("function");expect(event.currentContent()).toBe('latest\ndraft');
 expect(f.controller.snapshotPending()[0].data).toBe('latest\ndraft');
 expect(f.view.text).toBe('');expect(f.stored()).toBe('base');expect(f.write).toHaveBeenCalledTimes(1);
 f.view.file={path:'owned.md'};f.view.lastSavedData='base';f.view.text='owned edit';
 await f.view.save();expect(f.stored()).toBe('owned edit');expect(event.currentContent()).toBe('latest\ndraft');
 f.scope.sessionId='new';expect(()=>event.currentContent()).toThrow();
});
it('does not detach a denied draft if recovery cannot retain it',async()=>{
 const f=fixture();f.write.mockRejectedValue(Object.assign(new Error('Read only'),{code:'EACCES'}));
 f.recover.mockImplementation(()=>{throw new Error('recovery unavailable');});
 await expect(f.view.save(true)).rejects.toMatchObject({code:'EACCES'});expect(f.view.text).toBe('draft');
});


it('keeps a restored draft available without reading the original back into recovery',async()=>{
 const f=fixture();f.write.mockRejectedValue(Object.assign(new Error('Read only'),{code:'EACCES'}));
 await expect(f.view.save()).rejects.toThrow();const first=f.recover.mock.calls.at(-1)[0];
 first.restoreOriginal();expect(first.currentContent()).toBe('draft');
 expect(f.controller.snapshotPending()[0].data).toBe('draft');
 first.restoreOriginal();expect(f.view.text).toBe('base');
 f.view.text='second draft';await expect(f.view.save()).rejects.toThrow();
 const second=f.recover.mock.calls.at(-1)[0];second.restoreOriginal();
 expect(second.currentContent()).toBe('second draft');expect(second.saveCopy).toBeTypeOf('function');
});
it('retains all recovery actions after unload without restoring stale content into a reopened note',async()=>{
 const f=fixture();f.write.mockRejectedValue(Object.assign(new Error('Read only'),{code:'EACCES'}));
 await f.view.save(true);const event=f.recover.mock.calls.at(-1)[0];
 f.app.workspace.getActiveViewOfType=()=>f.view;
 f.view.lastSavedData='new remote original';f.view.text='new remote original';
 event.restoreOriginal();expect(f.view.text).toBe('new remote original');expect(event.currentContent()).toBe('draft');
 f.view.text='new edits';expect(()=>event.restoreOriginal()).toThrow();
 expect(event.saveCopy).toBeTypeOf('function');
});

it('resumes a denied save only on a new edit and resolves its recovery after acknowledgement',async()=>{
 vi.useFakeTimers();const f=fixture();f.write.mockRejectedValueOnce(Object.assign(new Error('Read only'),{code:'EACCES'}));
 await expect(f.view.save()).rejects.toMatchObject({code:'EACCES'});
 const denied=f.recover.mock.calls.at(-1)[0];
 await vi.advanceTimersByTimeAsync(3000);expect(f.write).toHaveBeenCalledTimes(1);
 f.view.text='new edit';f.view.requestSave();await vi.advanceTimersByTimeAsync(2100);
 expect(f.stored()).toBe('new edit');expect(f.controller.snapshotPending()).toEqual([]);
 expect(f.recover).toHaveBeenCalledWith(expect.objectContaining({resolved:true,recoveryToken:denied.recoveryToken}));
});
it('does not overwrite remote changes when write permission returns',async()=>{
 vi.useFakeTimers();const f=fixture();f.write.mockRejectedValueOnce(Object.assign(new Error('Read only'),{code:'EACCES'}));
 await expect(f.view.save()).rejects.toThrow();await f.app.vault.modify(f.view.file,'remote change');
 f.view.requestSave();await vi.advanceTimersByTimeAsync(2100);
 expect(f.stored()).toBe('remote change');expect(f.recover.mock.calls.at(-1)[0].code).toBe('CONTENT_CONFLICT');
 f.view.requestSave();await vi.advanceTimersByTimeAsync(2100);expect(f.write).toHaveBeenCalledTimes(2);
});

it.each([undefined,'1.14.3','1.14.5','unknown'])('rejects unsupported Obsidian %s before patching native methods',version=>{
 class TextFileView{save(){}}
 const before=TextFileView.prototype.save;
 expect(()=>installEditorSaves({TextFileView},{},()=>{},()=>({}),()=>{},{version})).toThrow('Unsupported Obsidian');
 expect(TextFileView.prototype.save).toBe(before);
});

it('captures dirty text before its debounce and the latest edits during an in-flight save',async()=>{
 const f=fixture();
 expect(f.controller.snapshotPending()).toEqual([{path:'note.md',data:'draft',encoding:'utf8'}]);
 let release;f.adapter.queue=fn=>new Promise(r=>release=()=>r(Promise.resolve().then(fn)));
 const saving=f.view.save();f.view.text='new text while waiting';f.view.dirty=true;
 expect(f.controller.snapshotPending()).toEqual([{path:'note.md',data:'new text while waiting',encoding:'utf8'}]);
 release();await saving;
 expect(f.controller.snapshotPending()).toEqual([{path:'note.md',data:'new text while waiting',encoding:'utf8'}]);
 f.scope.sessionId='other';expect(f.controller.snapshotPending()).toEqual([]);
});
it('keeps the retained draft instead of the restored baseline in logout recovery',async()=>{
 const f=fixture();f.write.mockRejectedValueOnce(Object.assign(new Error('Read only'),{code:'EACCES'}));
 await expect(f.view.save()).rejects.toThrow();f.recover.mock.calls.at(-1)[0].restoreOriginal();
 expect(f.view.text).toBe('base');expect(f.controller.snapshotPending()[0].data).toBe('draft');
});

it('excludes views created without a session from locked-session recovery',()=>{
 const f=fixture();f.scope.sessionId=null;
 const unowned=new f.TextFileView();unowned.text='unowned';unowned.onload();
 f.app.workspace.iterateAllLeaves=fn=>{fn({view:f.view});fn({view:unowned});};
 expect(f.controller.snapshotPending()).toEqual([{path:'note.md',data:'draft',encoding:'utf8'}]);
});
