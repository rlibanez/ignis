import {it,expect,vi} from 'vitest';
import {createSharedPanelApi} from './shared-panel.js';
it('binds placement to the session and sends only resource and destination',async()=>{
 const request=vi.fn(async()=>({ok:true,json:async()=>({ok:true})}));const api=createSharedPanelApi(()=> 'session',request);
 await api({id:'resource',vault:'destination',localPath:'Work/Alias'});
 expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({operation:'destination',input:{id:'resource',vault:'destination',localPath:'Work/Alias'}});
 expect(request.mock.calls[0][1].headers['X-Ignis-Context']).toBe('session');
});
it('rejects requests and late responses across a session change',async()=>{
 let session='one';const request=vi.fn(async()=>{session='two';return {ok:true,json:async()=>({resources:[]})};});const api=createSharedPanelApi(()=>session,request);
 await expect(api()).rejects.toThrow('session changed');await expect(api({id:'x',vault:'y'})).rejects.toThrow('session changed');expect(request).toHaveBeenCalledTimes(1);
});
it('does not treat server denial as a successful selection',async()=>{const api=createSharedPanelApi(()=> 'session',async()=>({ok:false,json:async()=>({error:'Shared resource unavailable'})}));await expect(api({id:'x',vault:'y'})).rejects.toThrow('unavailable');});

import {createSharedViewRestorer} from './shared-panel.js';
it('materializes hidden restored Shared leaves without changing focus, state or other views',async()=>{
 const leaf={isDeferred:true,loadIfDeferred:vi.fn(async()=>{leaf.isDeferred=false;}),setViewState:vi.fn()};
 const workspace={getLeavesOfType:vi.fn(()=>[leaf]),revealLeaf:vi.fn()};
 const restorer=createSharedViewRestorer(workspace);restorer.schedule();restorer.schedule();await new Promise(resolve=>setTimeout(resolve,0));
 expect(workspace.getLeavesOfType).toHaveBeenCalledWith('ignis-shared-resources');expect(leaf.loadIfDeferred).toHaveBeenCalledTimes(1);expect(leaf.setViewState).not.toHaveBeenCalled();expect(workspace.revealLeaf).not.toHaveBeenCalled();
 restorer.schedule();await new Promise(resolve=>setTimeout(resolve,0));expect(leaf.loadIfDeferred).toHaveBeenCalledTimes(1);
});
it('handles deferred leaves restored by a later layout change',async()=>{
 const leaves=[],restorer=createSharedViewRestorer({getLeavesOfType:()=>leaves});restorer.schedule();await new Promise(resolve=>setTimeout(resolve,0));
 const leaf={isDeferred:true,loadIfDeferred:vi.fn(async()=>{})};leaves.push(leaf);restorer.schedule();await new Promise(resolve=>setTimeout(resolve,0));expect(leaf.loadIfDeferred).toHaveBeenCalledOnce();
});
it('cancels queued restoration when the plugin unloads',async()=>{
 const workspace={getLeavesOfType:vi.fn(()=>[])};const restorer=createSharedViewRestorer(workspace);restorer.schedule();restorer.stop();await new Promise(resolve=>setTimeout(resolve,0));expect(workspace.getLeavesOfType).not.toHaveBeenCalled();
});

import {createSharedUnread} from './shared-panel.js';
it('counts only received resources and acknowledges only rendered resource IDs',()=>{
 let stored;const state=createSharedUnread(()=>stored,value=>{stored=value;});
 state.update([{id:'own',owned:true},{id:'new',owned:false},{id:'below-fold',owned:false}]);
 expect(state.pending()).toEqual(['new','below-fold']);state.mark('own');state.mark('unknown');
 expect(state.pending()).toEqual(['new','below-fold']);state.mark('new');
 expect(state.pending()).toEqual(['below-fold']);
 const restored=createSharedUnread(()=>stored,()=>{});restored.update([{id:'new',owned:false},{id:'below-fold',owned:false}]);
 expect(restored.pending()).toEqual(['below-fold']);
});
it('does not notify on metadata changes and removes revoked resources from the count',()=>{
 const state=createSharedUnread(()=>null,()=>{});state.update([{id:'x',owned:false}]);state.mark('x');
 state.update([{id:'x',owned:false,name:'renamed',revision:3},{id:'y',owned:false}]);expect(state.pending()).toEqual(['y']);
 state.update([{id:'x',owned:false}]);expect(state.pending()).toEqual([]);
});
it('tolerates unavailable storage and merges acknowledgements from other tabs',()=>{
 let stored='invalid';const state=createSharedUnread(()=>stored,()=>{throw new Error('unavailable');});
 state.update([{id:'x',owned:false},{id:'y',owned:false}]);state.mark('x');expect(state.pending()).toEqual(['y']);
 stored='["y"]';state.update([{id:'x',owned:false},{id:'y',owned:false}]);expect(state.pending()).toEqual([]);
});
