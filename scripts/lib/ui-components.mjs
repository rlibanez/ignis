import {uiIsolation} from "./ui-isolation.mjs";
import assert from 'node:assert/strict';
// Exercise Svelte bindings against actual native controls and the independent host.
export async function uiComponents(clients) {
 for(const client of clients) {
  await client.run(`{window.uiSaved=null;window.uiCase=new IgnisUI.PromptDialog({target:document.body,props:{title:'Name test',value:'old'}});uiCase.$on('confirm',event=>{uiSaved=event.detail;uiCase.$destroy();});}`);
  await client.wait(`!!document.querySelector('#prompt-input')`,'prompt field');
  assert.equal(await client.run(`!!document.querySelector('#prompt-input').closest('.modal-shell') && !document.querySelector('#prompt-input').dataset.uiComponent`),true,'upstream prompt keeps its original shell and controls');
  await client.run(`{const field=document.querySelector('#prompt-input');field.value='new name';field.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await client.run(`document.querySelector('#prompt-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  assert.equal(await client.run(`uiSaved`),'new name','Enter confirms the bound native field value');
  await client.run(`{window.uiSelectTarget=document.createElement('div');uiSelectTarget.id='ui-select-contract';document.body.append(uiSelectTarget);window.uiCase=new IgnisUI.Field({target:uiSelectTarget,props:{type:'select',value:'a',options:[{value:'a',label:'A'}]}});}`);
  await client.wait(`!!document.querySelector('#ui-select-contract select')`,'select contract');
  await client.run(`uiCase.$set({value:'b',options:[{value:'b',label:'B'},{value:'c',label:'C',disabled:true}]})`);
  await client.wait(`document.querySelector('#ui-select-contract select').value==='b'`,'reactive native choices');
  assert.deepEqual(await client.run(`[...document.querySelector('#ui-select-contract select').options].map(option=>[option.value,option.textContent,option.disabled])`),[['b','B',false],['c','C',true]]);
  await client.run(`uiCase.$destroy();uiSelectTarget.remove()`);

 }
 await uiIsolation(clients);
 console.log(JSON.stringify({uiComponents:'passed',hosts:clients.length,checks:['original upstream prompt preserved','prompt Enter binding','reactive choices for our native fields']}));
}
