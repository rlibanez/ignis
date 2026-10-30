import {it,expect,vi} from 'vitest';
import {installSharedIcons} from './shared-icons.js';
it('decorates resources without altering names and removes badges on revocation and logout',async()=>{
 let info={owner:'alice',role:'editor'},changed,logout,observer;
 const item={getAttribute:()=> 'Work/Notes',querySelector(){return this.icon || null;},append(icon){this.icon=icon;}};
 const host={document:{body:{},querySelectorAll:selector=>selector==='.ignis-shared-marker'?(item.icon?[item.icon]:[]):[item],createElement:()=>({style:{},setAttribute:vi.fn(),remove(){delete item.icon;}})},MutationObserver:class{constructor(fn){changed=fn;observer=this;}observe=vi.fn();disconnect=vi.fn();},addEventListener:(name,fn)=>{logout=fn;}};
 const unsubscribe=vi.fn(),icons={setIcon:vi.fn()},files={describe:()=>info,subscribe:fn=>{changed=fn;return unsubscribe;}};
 installSharedIcons(icons,files,host);await new Promise(resolve=>setTimeout(resolve,0));expect(icons.setIcon).toHaveBeenCalledWith(item.icon,'users');expect(item.icon.title).toBe('Shared by alice · Read / Write');
 changed();await new Promise(resolve=>setTimeout(resolve,0));expect(icons.setIcon).toHaveBeenCalledTimes(1);
 info={direction:'outgoing'};changed();await new Promise(resolve=>setTimeout(resolve,0));expect(icons.setIcon).toHaveBeenLastCalledWith(item.icon,'share-2');expect(item.icon.title).toBe('Shared by you');
 info=null;changed();await new Promise(resolve=>setTimeout(resolve,0));expect(item.icon).toBeUndefined();logout();expect(observer.disconnect).toHaveBeenCalled();expect(unsubscribe).toHaveBeenCalled();
});
