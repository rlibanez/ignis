import {it,expect,vi} from 'vitest';
import {createSharedNotice} from './shared-notice.js';
function fixture(ordinary=false){
 const nodes=[],events={},context={sessionId:'session',vault:'vault'},leaves=[];
 function element(tag){const node={tag,style:{setProperty(key,value,priority){this[key]=value;this[key+"Priority"]=priority;},removeProperty(key){delete this[key];delete this[key+"Priority"];}},children:[],attrs:{},textContent:'',setAttribute(k,v){this.attrs[k]=v;},append(...children){for(const child of children){child.parent=this;this.children.push(child);}},prepend(child){child.parent=this;this.children.unshift(child);},replaceChildren(){this.children=[];},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);},click(){this.onclick?.();}};nodes.push(node);return node;}
 const body=element('body'),host={document:{body,head:element('head'),getElementById:id=>nodes.find(node=>node.id===id),createElement:element},addEventListener:(name,fn)=>events[name]=fn,URL:{createObjectURL:vi.fn(()=> 'blob:recovery'),revokeObjectURL:vi.fn()},Blob,app:{workspace:{iterateAllLeaves:fn=>leaves.forEach(fn)}}};
 const notice=createSharedNotice(()=>context,host,ordinary);
 const find=text=>nodes.findLast(n=>n.textContent===text),close=()=>nodes.findLast(n=>n.attrs['aria-label']==='Close').click();
 const fail=(content='draft')=>notice.failure({path:'Shared/note.md',content,...context});
 return {host,body,events,context,leaves,notice,find,close,fail,nodes};
}
it('dismisses the global notice while keeping recovery available, without repeated identical alerts',async()=>{
 const f=fixture();f.fail();expect(f.find('Shared/note.md')).toBeDefined();f.close();expect(f.body.children.map(n=>n.tag)).toEqual(['button']);
 f.fail();expect(f.body.children.map(n=>n.tag)).toEqual(['button']);
 f.find('Manage changes').click();f.find('Download recovery copy').click();
 const blob=f.host.URL.createObjectURL.mock.calls[0][0];expect(JSON.parse(await blob.text()).files['Shared/note.md'].content).toBe('draft');
 f.close();f.fail('new draft');expect(f.body.children.map(n=>n.tag)).toEqual(['aside']);
});
it('retains only actual unsaved changes from the affected removed shared editor',()=>{
 const f=fixture();f.leaves.push({view:{file:{path:'Shared/note.md'},lastSavedData:'saved text',editor:{getValue:()=> 'shared text'}}},{view:{file:{path:'Local.md'},editor:{getValue:()=> 'local text'}}});
 f.notice.removed('Shared/note.md');expect(f.nodes.some(n=>n.textContent.includes('Download your unsaved changes'))).toBe(true);expect(f.nodes.some(n=>n.textContent==='Local.md')).toBe(false);
 expect(f.nodes.some(n=>n.textContent.includes('could not be saved'))).toBe(false);
});
it('does not raise a save failure when a removed resource has no open editor',()=>{const f=fixture();f.notice.removed('Missing.md');expect(f.body.children).toEqual([]);});
it('suppresses a dismissed repeated generic warning without a recovery copy',()=>{const f=fixture();f.notice.show('Unavailable');f.close();f.notice.show('Unavailable');expect(f.body.children).toEqual([]);});
it('clears recovery on logout and prevents downloading under another session or vault',()=>{
 const f=fixture();f.fail();f.close();f.events['ignis:auth-lost']();expect(f.body.children).toEqual([]);
 f.fail();f.close();f.context.vault='other';f.find('Manage changes').click();expect(f.body.children).toEqual([]);expect(f.host.URL.createObjectURL).not.toHaveBeenCalled();
 f.fail();f.context.sessionId='other';f.find('Download recovery copy').click();expect(f.host.URL.createObjectURL).not.toHaveBeenCalled();
});
it('renders file names as text and revokes previous download URLs',()=>{
 const f=fixture();f.notice.failure({path:'<img onerror=bad>',content:'draft',...f.context});expect(f.find('<img onerror=bad>').tag).toBe('li');
 f.find('Download recovery copy').click();f.find('Download recovery copy').click();expect(f.host.URL.revokeObjectURL).toHaveBeenCalledWith('blob:recovery');
});

it('captures a downgraded editor with an accurate read-only explanation',async()=>{
 const f=fixture();f.leaves.push({view:{file:{path:'Shared/note.md'},lastSavedData:'saved text',editor:{getValue:()=> 'unsubmitted draft'}}});
 f.notice.removed('Shared/note.md','read-only');
 expect(f.nodes.some(n=>n.textContent.includes('You do not have write permission'))).toBe(true);
 expect(f.nodes.some(n=>n.textContent.includes('no longer available'))).toBe(false);
 f.find('Download note').click();
 expect(await f.host.URL.createObjectURL.mock.calls[0][0].text()).toBe('unsubmitted draft');
});

it('offers dismissible ordinary recovery without claiming local notes are unaffected',async()=>{
 const f=fixture(true);f.notice.failure({path:'note.md',content:'my draft',...f.context});
 expect(f.nodes.some(n=>n.textContent.includes('content changed'))).toBe(true);
 expect(f.nodes.some(n=>n.textContent.includes('local notes are unaffected'))).toBe(false);
 f.find('Download recovery copy').click();
 expect(JSON.parse(await f.host.URL.createObjectURL.mock.calls[0][0].text()).files['note.md'].content).toBe('my draft');
 f.close();expect(f.find('Manage changes')).toBeDefined();f.events['ignis:auth-lost']();expect(f.body.children).toEqual([]);
});

it('exports exact Unicode drafts for multiple files and retains recovery after download',async()=>{
 const f=fixture(),drafts={'Shared/á.md':'# Borrador\nñ 👩🏽‍💻\n','Shared/empty.md':''};
 for(const [path,content] of Object.entries(drafts))f.notice.failure({path,content,...f.context});
 f.find('Download recovery copy').click();
 const blob=f.host.URL.createObjectURL.mock.calls[0][0],data=JSON.parse(await blob.text());
 for(const [path,content] of Object.entries(drafts))expect(data.files[path].content).toBe(content);
 expect(Object.keys(data.files).sort()).toEqual(Object.keys(drafts).sort());
 f.close();f.find('Manage changes').click();f.find('Download recovery copy').click();
 const second=JSON.parse(await f.host.URL.createObjectURL.mock.calls[1][0].text());
 expect(second.files).toEqual(data.files);
});

it.each([true,false])('explains denied writes and reopens a dismissed notice for new edits (ordinary=%s)',async ordinary=>{
 const f=fixture(ordinary),fail=content=>f.notice.failure({path:'read.md',content,code:'EACCES',...f.context});
 fail('first');expect(f.find(ordinary?'Manage account':'Manage shared resources').parent).toBeUndefined();expect(f.nodes.some(n=>n.textContent.includes('You do not have write permission'))).toBe(true);
 f.close();fail('first');expect(f.body.children.map(n=>n.tag)).toEqual(['button']);
 fail('latest');expect(f.body.children.map(n=>n.tag)).toEqual(['aside']);
 f.find('Download note').click();
 expect(await f.host.URL.createObjectURL.mock.calls[0][0].text()).toBe('latest');
});

it('dismisses after restoring original content while retaining the downloadable draft',async()=>{
 const f=fixture(true),restoreOriginal=vi.fn();
 f.notice.failure({path:'note.md',content:'draft',code:'EACCES',restoreOriginal,...f.context});
 f.find('Show original content').click();expect(restoreOriginal).toHaveBeenCalledOnce();
 expect(f.body.children.map(n=>n.tag)).toEqual(['button']);
 f.find('Manage changes').click();f.find('Download note').click();
 expect(await f.host.URL.createObjectURL.mock.calls[0][0].text()).toBe('draft');
});
it('orders copy, note download and restore actions and closes only after copying succeeds',()=>{
 const f=fixture(true),saveCopy=vi.fn();f.notice.failure({path:'note.md',content:'draft',code:'EACCES',saveCopy,restoreOriginal:vi.fn(),...f.context});
 const copy=f.find('Save a copy');expect(copy.parent.children.map(n=>n.textContent)).toEqual(['Save a copy','Download note','Show original content']);
 copy.click();expect(f.body.children.map(n=>n.tag)).toEqual(['aside']);saveCopy.mock.calls[0][0]();expect(f.body.children.map(n=>n.tag)).toEqual(['button']);
});

it('downloads the current editor text rather than the earlier failed save snapshot',async()=>{
 const f=fixture(true);let text='old draft';
 f.notice.failure({path:'note.md',content:text,code:'EACCES',currentContent:()=>text,...f.context});
 text='latest draft';f.find('Download note').click();
 expect(await f.host.URL.createObjectURL.mock.calls[0][0].text()).toBe('latest draft');
});

it('hides recovery UI on unrelated notes and restores it on the affected note without losing data',()=>{
 const f=fixture(true);let active={path:'read.md'};const listeners={};
 f.host.app.workspace.getActiveFile=()=>active;
 f.host.app.workspace.on=(name,fn)=>{listeners[name]=fn;return name;};
 const notice=createSharedNotice(()=>f.context,f.host,true);
 notice.failure({path:'read.md',content:'draft',code:'EACCES',...f.context});
 const panel=f.body.children[0];expect(panel.hidden).toBe(false);
 active={path:'mine.md'};listeners['file-open']();expect(panel.hidden).toBe(true);
 active={path:'read.md'};listeners['file-open']();expect(panel.hidden).toBe(false);
 f.close();const recovery=f.find('Manage changes');
 active={path:'new.md'};listeners['active-leaf-change']();expect(recovery.hidden).toBe(true);expect(recovery.style.display).toBe("none");expect(recovery.style.displayPriority).toBe("important");
 active={path:'read.md'};listeners['file-open']();expect(recovery.hidden).toBe(false);expect(recovery.style.display).toBeUndefined();
});

it('places the recovery control in the status bar without overlay positioning',()=>{
 const f=fixture(true),status=f.host.document.createElement('div');
 f.host.document.querySelector=selector=>selector==='.status-bar'?status:null;
 f.fail();f.close();const button=f.find('Manage changes');
 expect(button.parent).toBe(status);expect(status.children[0]).toBe(button);expect(button.style.order).toBe('-1');expect(button.style.position).toBe('static');
 expect(button.style.bottom).toBeUndefined();button.click();expect(f.body.children.some(n=>n.tag==='aside')).toBe(true);
});

it('keeps all three actions after showing the original and reopening recovery repeatedly',async()=>{
 const f=fixture(true),restoreOriginal=vi.fn(),saveCopy=vi.fn();
 f.notice.failure({path:'note.md',content:'draft',code:'EACCES',restoreOriginal,saveCopy,currentContent:()=> 'draft',...f.context});
 for(let i=0;i<3;i++){
  f.find('Show original content').click();f.find('Manage changes').click();
  expect(f.find('Save a copy').parent.children.map(n=>n.textContent)).toEqual(['Save a copy','Download note','Show original content']);
 }
 f.find('Save a copy').click();expect(saveCopy).toHaveBeenCalledOnce();
 f.find('Download note').click();expect(await f.host.URL.createObjectURL.mock.calls[0][0].text()).toBe('draft');
});

it('keeps buttons mounted through focus events and repeated identical save failures',()=>{
 const f=fixture(true),listeners={};
 f.host.app.workspace.getActiveFile=()=>({path:'note.md'});
 f.host.app.workspace.on=(name,fn)=>{listeners[name]=fn;return name;};
 const notice=createSharedNotice(()=>f.context,f.host,true),event={path:'note.md',content:'draft',code:'EACCES',...f.context};
 notice.failure(event);const panel=f.body.children[0],children=[...panel.children],download=f.find('Download note');
 listeners['active-leaf-change']();listeners['file-open']();notice.failure(event);
 expect(panel.children).toEqual(children);download.click();expect(f.host.URL.createObjectURL).toHaveBeenCalledOnce();
 expect(panel.attrs['aria-label']).toBeUndefined();
 expect(panel.style.zIndex).toBe('var(--layer-popover, 30)');
 f.close();const control=f.find('Manage changes');expect(control.title).toBeUndefined();
 expect(control.attrs['aria-label']).toBe('Manage unsaved changes');
});
it.each(['read-only',undefined])('does not create recovery for unchanged open editors on access change (%s)',reason=>{
 const f=fixture(),save=vi.fn();
 f.leaves.push({view:{file:{path:'Shared/note.md'},lastSavedData:'saved',dirty:true,editor:{getValue:()=> 'saved'},getViewData:()=> 'saved',save}});
 f.notice.removed('Shared/note.md',reason);expect(f.body.children).toEqual([]);expect(save).not.toHaveBeenCalled();
});
it('does not infer unsaved changes merely from an editor without a saved baseline',()=>{
 const f=fixture();f.leaves.push({view:{file:{path:'Shared/note.md'},dirty:false,editor:{getValue:()=> 'content'}}});
 f.notice.removed('Shared/note.md','read-only');expect(f.body.children).toEqual([]);
});
it('uses the normal denied-write recovery actions after a downgrade with actual edits',async()=>{
 const f=fixture(),saveCopy=vi.fn(),restoreOriginal=vi.fn();
 const save=vi.fn(async()=>{
  f.notice.failure({path:'Shared/note.md',content:'draft',code:'EACCES',saveCopy,restoreOriginal,...f.context});
  throw Object.assign(new Error('Read only'),{code:'EACCES'});
 });
 f.leaves.push({view:{file:{path:'Shared/note.md'},lastSavedData:'saved',editor:{getValue:()=> 'draft'},save}});
 f.notice.removed('Shared/note.md','read-only');expect(save).not.toHaveBeenCalled();
 await new Promise(resolve=>setTimeout(resolve,0));expect(save).toHaveBeenCalledOnce();
 expect(f.find('Save a copy').parent.children.map(n=>n.textContent)).toEqual(['Save a copy','Download note','Show original content']);
});
it('leaves recovery of an in-flight save to the save integration without duplicate warnings',()=>{
 const f=fixture(),save=vi.fn();f.leaves.push({view:{file:{path:'Shared/note.md'},lastSavedData:'draft',saving:true,editor:{getValue:()=> 'draft'},save}});
 f.notice.removed('Shared/note.md','read-only');expect(save).not.toHaveBeenCalled();expect(f.body.children).toEqual([]);
});

it('clears acknowledged recovery only for its matching token and account',()=>{
 const f=fixture(),recoveryToken={};
 f.notice.failure({path:'note.md',content:'draft',code:'EACCES',recoveryToken,...f.context});
 f.notice.failure({path:'note.md',resolved:true,recoveryToken:{},...f.context});expect(f.body.children).not.toEqual([]);
 f.notice.failure({path:'note.md',resolved:true,recoveryToken,...f.context,sessionId:'other'});expect(f.body.children).not.toEqual([]);
 f.notice.failure({path:'note.md',resolved:true,recoveryToken,...f.context});expect(f.body.children).toEqual([]);
});

it('scopes recovery styling to its own panel and retains native button appearance',()=>{
 const f=fixture();f.fail();
 const panel=f.body.children[0];expect(panel.className).toBe('ignis-recovery-notice');
 expect(panel.style.background).toBeUndefined();expect(panel.style.font).toBeUndefined();
 const download=f.find('Download recovery copy');expect(download.style.background).toBeUndefined();expect(download.style.boxShadow).toBeUndefined();
 expect(f.host.document.head.children.filter(node=>node.id==='ignis-recovery-notice-style')).toHaveLength(1);
 createSharedNotice(()=>f.context,f.host);expect(f.host.document.head.children.filter(node=>node.id==='ignis-recovery-notice-style')).toHaveLength(1);
});
