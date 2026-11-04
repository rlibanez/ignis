import {it,expect,vi} from 'vitest';
import {installRenameKeyboard} from './rename-keyboard.js';
function fixture(){
 const handlers={},attrs=new Map(),frames=[];let cleanup;
 const field={isContentEditable:true,matches:vi.fn(()=>true),getAttribute:key=>attrs.get(key)??null,setAttribute:(key,value)=>attrs.set(key,value),removeAttribute:key=>attrs.delete(key)};
 const document={body:{classList:{contains:()=>true}},activeElement:field,visibilityState:'visible'};
 const keyboard={show:vi.fn(()=>expect(attrs.get('virtualkeyboardpolicy')).toBe('manual'))};
 installRenameKeyboard({register:fn=>cleanup=fn,registerDomEvent:(_target,name,handler)=>handlers[name]=handler},{document,navigator:{virtualKeyboard:keyboard},requestAnimationFrame:fn=>frames.push(fn)});
 return {handlers,attrs,field,document,keyboard,frames,cleanup:()=>cleanup()};
}
it('opens the keyboard for a focused native rename and keeps manual policy until the native rename loses focus',()=>{
 const f=fixture();f.handlers.focusin({target:f.field});expect(f.keyboard.show).toHaveBeenCalledOnce();expect(f.attrs.get('virtualkeyboardpolicy')).toBe('manual');
 f.handlers.pointerup({target:f.field});expect(f.keyboard.show).toHaveBeenCalledTimes(2);
 f.handlers.focusout({target:f.field});expect(f.attrs.has('virtualkeyboardpolicy')).toBe(false);
});
it.each(['desktop','background','other field','not editable','not focused'])('does not open the keyboard for %s',mode=>{
 const f=fixture();
 if(mode==='desktop')f.document.body.classList.contains=()=>false;
 if(mode==='background')f.document.visibilityState='hidden';
 if(mode==='other field')f.field.matches=()=>false;
 if(mode==='not editable')f.field.isContentEditable=false;
 if(mode==='not focused')f.document.activeElement={};
 f.handlers.focusin({target:f.field});expect(f.keyboard.show).not.toHaveBeenCalled();
});
it('restores existing policy when the browser refuses and tolerates unavailable APIs',()=>{
 const f=fixture();f.attrs.set('virtualkeyboardpolicy','auto');f.keyboard.show.mockImplementation(()=>{throw Error('denied');});
 expect(()=>f.handlers.focusin({target:f.field})).not.toThrow();expect(f.attrs.get('virtualkeyboardpolicy')).toBe('auto');
 delete f.keyboard.show;expect(()=>f.handlers.focusin({target:f.field})).not.toThrow();
});

it('restores the original policy on plugin unload and does not restore unrelated fields',()=>{
 const f=fixture();f.attrs.set('virtualkeyboardpolicy','auto');f.handlers.focusin({target:f.field});
 f.handlers.focusout({target:{}});expect(f.attrs.get('virtualkeyboardpolicy')).toBe('manual');
 f.cleanup();expect(f.attrs.get('virtualkeyboardpolicy')).toBe('auto');
});

it('requests once more after native focus handlers, but never after blur',()=>{
 const f=fixture();f.handlers.focusin({type:'focusin',target:f.field});
 expect(f.frames).toHaveLength(1);f.frames.shift()();expect(f.keyboard.show).toHaveBeenCalledTimes(2);
 f.handlers.focusin({type:'focusin',target:f.field});f.handlers.focusout({target:f.field});
 f.frames.shift()();expect(f.keyboard.show).toHaveBeenCalledTimes(3);
});
