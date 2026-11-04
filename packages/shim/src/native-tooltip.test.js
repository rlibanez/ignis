import {it,expect,vi} from 'vitest';
import {nativeTooltip} from './native-tooltip.js';
function fixture(tagName='BUTTON') {
 const el=new EventTarget();el.tagName=tagName;const attrs=new Map([['title','old']]);
 el.setAttribute=(k,v)=>attrs.set(k,v);el.removeAttribute=k=>attrs.delete(k);
 const over=vi.fn(),out=vi.fn();el.addEventListener('pointerover',over);el.addEventListener('pointerout',out);
 nativeTooltip({Event},el,'Help text',{help:true});
 const fire=(type,key)=>{const event=new Event(type,{cancelable:true});if(key)Object.defineProperty(event,'key',{value:key});el.dispatchEvent(event);return event;};
 return {el,attrs,over,out,fire};
}
it('uses native tooltip metadata without a second title or custom tooltip element',()=>{
 const f=fixture();expect(f.attrs.get('aria-label')).toBe('Help text');expect(f.attrs.has('title')).toBe(false);
 f.fire('focus');expect(f.over).toHaveBeenCalledOnce();expect(f.attrs.get('data-tooltip-delay')).toBe('1');
 f.fire('keydown','Escape');expect(f.out).toHaveBeenCalledOnce();f.fire('blur');expect(f.out).toHaveBeenCalledTimes(2);
});
it('opens from a touch-generated click after native pointerup dismissal',()=>{
 const f=fixture();f.fire('pointerup');const click=f.fire('click');
 expect(f.over).toHaveBeenCalledOnce();expect(click.defaultPrevented).toBe(true);
});
it('supports keyboard activation of informational badges and avoids duplicate handlers on refresh',()=>{
 const f=fixture('SPAN');expect(f.el.tabIndex).toBe(0);expect(f.attrs.get('role')).toBe('button');
 nativeTooltip({Event},f.el,'Updated help',{help:true});
 f.fire('keydown','Enter');f.fire('keydown',' ');expect(f.over).toHaveBeenCalledTimes(2);
 expect(f.attrs.get('aria-label')).toBe('Updated help');
});
