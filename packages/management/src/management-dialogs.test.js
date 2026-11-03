import {it,expect,vi,afterEach} from 'vitest';
import {installManagementDialogs} from './management-dialogs.js';
afterEach(()=>vi.unstubAllGlobals());
it('anchors mobile dialogs to layout, independently of a native opening transform',()=>{
 const listeners=new Map(),setProperty=vi.fn(),disconnect=vi.fn();
 vi.stubGlobal('document',{body:{classList:{contains:()=>true}},createElement:()=>({textContent:''})});
 vi.stubGlobal('window',{scrollY:0,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name)=>listeners.delete(name)});
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect=disconnect;});
 const frame={append(){},classList:{add(){}},querySelectorAll:()=>[]};
 const modal={offsetTop:24,offsetParent:{offsetTop:16,offsetParent:null},getBoundingClientRect:()=>({top:844})};
 const dialogs=installManagementDialogs(frame,{style:{setProperty}},modal,()=>{});
 expect(setProperty).toHaveBeenLastCalledWith('--management-sheet-top','40px');
 modal.offsetTop=32;listeners.get('resize')();
 expect(setProperty).toHaveBeenLastCalledWith('--management-sheet-top','48px');
 dialogs.dispose();expect(disconnect).toHaveBeenCalledOnce();expect(listeners.size).toBe(0);
});
