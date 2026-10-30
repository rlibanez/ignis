import {it,expect,vi} from 'vitest';
import {createSharedNotice} from './shared-notice.js';
function fixture(ordinary=false){
 const nodes=[],events={},context={sessionId:'session',vault:'vault'},leaves=[];
 function element(tag){const node={tag,style:{},children:[],attrs:{},textContent:'',setAttribute(k,v){this.attrs[k]=v;},append(...children){for(const child of children){child.parent=this;this.children.push(child);}},replaceChildren(){this.children=[];},remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);},click(){this.onclick?.();}};nodes.push(node);return node;}
 const body=element('body'),host={document:{body,createElement:element},addEventListener:(name,fn)=>events[name]=fn,URL:{createObjectURL:vi.fn(()=> 'blob:recovery'),revokeObjectURL:vi.fn()},Blob,app:{workspace:{iterateAllLeaves:fn=>leaves.forEach(fn)}}};
 const notice=createSharedNotice(()=>context,host,ordinary);
 const find=text=>nodes.findLast(n=>n.textContent===text),close=()=>nodes.findLast(n=>n.attrs['aria-label']?.startsWith('Dismiss')).click();
 const fail=(content='draft')=>notice.failure({path:'Shared/note.md',content,...context});
 return {host,body,events,context,leaves,notice,find,close,fail,nodes};
}
it('dismisses the global notice while keeping recovery available, without repeated identical alerts',async()=>{
 const f=fixture();f.fail();expect(f.find('Shared/note.md')).toBeDefined();f.close();expect(f.body.children.map(n=>n.tag)).toEqual(['button']);
 f.fail();expect(f.body.children.map(n=>n.tag)).toEqual(['button']);
 f.find('Recover shared changes').click();f.find('Download shared recovery copy').click();
 const blob=f.host.URL.createObjectURL.mock.calls[0][0];expect(JSON.parse(await blob.text()).files['Shared/note.md'].content).toBe('draft');
 f.close();f.fail('new draft');expect(f.body.children.map(n=>n.tag)).toEqual(['aside']);
});
it('describes removal as precautionary recovery and includes only the affected shared editor',()=>{
 const f=fixture();f.leaves.push({view:{file:{path:'Shared/note.md'},editor:{getValue:()=> 'shared text'}}},{view:{file:{path:'Local.md'},editor:{getValue:()=> 'local text'}}});
 f.notice.removed('Shared/note.md');expect(f.nodes.some(n=>n.textContent.includes('as a precaution'))).toBe(true);expect(f.nodes.some(n=>n.textContent==='Local.md')).toBe(false);
 expect(f.nodes.some(n=>n.textContent.includes('could not be saved'))).toBe(false);
});
it('does not raise a save failure when a removed resource has no open editor',()=>{const f=fixture();f.notice.removed('Missing.md');expect(f.body.children).toEqual([]);});
it('suppresses a dismissed repeated generic warning without a recovery copy',()=>{const f=fixture();f.notice.show('Unavailable');f.close();f.notice.show('Unavailable');expect(f.body.children).toEqual([]);});
it('clears recovery on logout and prevents downloading under another session or vault',()=>{
 const f=fixture();f.fail();f.close();f.events['ignis:auth-lost']();expect(f.body.children).toEqual([]);
 f.fail();f.close();f.context.vault='other';f.find('Recover shared changes').click();expect(f.body.children).toEqual([]);expect(f.host.URL.createObjectURL).not.toHaveBeenCalled();
 f.fail();f.context.sessionId='other';f.find('Download shared recovery copy').click();expect(f.host.URL.createObjectURL).not.toHaveBeenCalled();
});
it('renders file names as text and revokes previous download URLs',()=>{
 const f=fixture();f.notice.failure({path:'<img onerror=bad>',content:'draft',...f.context});expect(f.find('<img onerror=bad>').tag).toBe('li');
 f.find('Download shared recovery copy').click();f.find('Download shared recovery copy').click();expect(f.host.URL.revokeObjectURL).toHaveBeenCalledWith('blob:recovery');
});

it('captures a downgraded editor with an accurate read-only explanation',async()=>{
 const f=fixture();f.leaves.push({view:{file:{path:'Shared/note.md'},editor:{getValue:()=> 'unsubmitted draft'}}});
 f.notice.removed('Shared/note.md','read-only');
 expect(f.nodes.some(n=>n.textContent.includes('now read-only'))).toBe(true);
 expect(f.nodes.some(n=>n.textContent.includes('no longer available'))).toBe(false);
 f.find('Download shared recovery copy').click();
 expect(JSON.parse(await f.host.URL.createObjectURL.mock.calls[0][0].text()).files['Shared/note.md'].content).toBe('unsubmitted draft');
});

it('offers dismissible ordinary recovery without claiming local notes are unaffected',async()=>{
 const f=fixture(true);f.notice.failure({path:'note.md',content:'my draft',...f.context});
 expect(f.nodes.some(n=>n.textContent.includes('content changed'))).toBe(true);
 expect(f.nodes.some(n=>n.textContent.includes('local notes are unaffected'))).toBe(false);
 f.find('Download recovery copy').click();
 expect(JSON.parse(await f.host.URL.createObjectURL.mock.calls[0][0].text()).files['note.md'].content).toBe('my draft');
 f.close();expect(f.find('Recover unsaved changes')).toBeDefined();f.events['ignis:auth-lost']();expect(f.body.children).toEqual([]);
});
