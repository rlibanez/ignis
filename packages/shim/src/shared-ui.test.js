import {it,expect} from 'vitest';
import {confirmSharedAction} from './shared-ui.js';
function fixture(){
 let modal;
 const element=()=>({classList:{add(){}},children:[],append(...items){this.children.push(...items);},empty(){this.children=[];},focus(){}});
 const host=new EventTarget();host.document={createElement:element};host.__ignisAuth={blocked:false};
 class Modal {constructor(){modal=this;this.contentEl=element();this.modalEl=element();}setTitle(){}open(){this.onOpen();}close(){this.onClose();}}
 const result=confirmSharedAction({Modal},{},host,'Remove access','Resource','Remove');
 return {host,result,get modal(){return modal;}};
}
it('does not confirm when the dialog is dismissed',async()=>{const f=fixture();f.modal.close();expect(await f.result).toBe(false);});
it('requires the explicit destructive action',async()=>{const f=fixture();f.modal.contentEl.children[1].children[1].onclick();expect(await f.result).toBe(true);});
it('cancels an open confirmation on authentication loss',async()=>{const f=fixture();f.host.__ignisAuth.blocked=true;f.host.dispatchEvent(new Event('ignis:auth-lost'));expect(await f.result).toBe(false);});
