import {it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const {createStateEvents}=createRequire(import.meta.url)('./state-events');
function fixture(){
 const state={alice:{shares:{resources:[]}},bob:{shares:{resources:[]}}};
 const entries=new Map();
 const valid=vi.fn(ws=>!ws.revoked);
 const hub=createStateEvents({entries,valid,resolve:token=>({user:{id:token}}),snapshot:token=>state[token]});
 const socket=(user,events=true)=>{const ws={readyState:1,terminate:vi.fn()};const entry={token:user,events,stateSnapshot:hub.capture(user),sendState:vi.fn()};entries.set(ws,entry);return {ws,entry};};
 return {hub,state,socket,valid};
}
it('invalidates only changed account projections and never includes private metadata',()=>{
 const f=fixture(),a=f.socket('alice'),b=f.socket('bob');
 f.state.alice.shares.resources.push({path:'private/file.md',recipient:'sensitive'});f.hub.reconcile();
 expect(a.entry.sendState).toHaveBeenCalledExactlyOnceWith({type:'ignis-state',account:false,shares:true,vaults:false});expect(b.entry.sendState).not.toHaveBeenCalled();
 f.hub.reconcile();expect(a.entry.sendState).toHaveBeenCalledOnce();
});
it('targets file invalidations by authenticated recipient, never vault subscriptions',()=>{
 const f=fixture(),a=f.socket('alice'),b=f.socket('bob'),vault=f.socket('alice',false);
 f.hub.sharedContent(new Set(['alice']));expect(a.entry.sendState).toHaveBeenCalledExactlyOnceWith({type:'ignis-state',shares:true});expect(b.entry.sendState).not.toHaveBeenCalled();expect(vault.entry.sendState).not.toHaveBeenCalled();
});
it('revalidates connections before sending and terminates on snapshot failure',()=>{
 const f=fixture(),a=f.socket('alice');a.ws.revoked=true;f.state.alice={changed:true};f.hub.reconcile();expect(a.entry.sendState).not.toHaveBeenCalled();
 const entries=new Map([[a.ws,a.entry]]);const broken=createStateEvents({entries,valid:()=>true,resolve:()=>null,snapshot:()=>{throw Error('database');}});broken.reconcile();expect(a.ws.terminate).toHaveBeenCalledOnce();
});
