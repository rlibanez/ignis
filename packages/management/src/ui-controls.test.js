import {it,expect} from 'vitest';
import {createUiElement,nativeComponent} from './ui-controls.js';
import {fixture} from './ui-fixture.test-helper.js';
it('constructs real provided components and keeps their element identity',()=>{
 const {doc}=fixture();const calls=[];
 const component=(name,tag,key)=>class{constructor(container){calls.push(name);this[key]=doc.createElement(tag);container.append(this[key]);}};
 const runtime={controls:new WeakMap(),TextComponent:component('text','input','inputEl'),TextAreaComponent:component('textarea','textarea','inputEl'),ButtonComponent:component('button','button','buttonEl'),DropdownComponent:component('select','select','selectEl')};
 doc.defaultView.__ignisUiRuntime=runtime;
 for(const tag of ['input','textarea','button','select']){
  const el=createUiElement(doc,tag);expect(nativeComponent(el)).toBe(runtime.controls.get(el));expect(el.dataset.uiComponent).toBeTruthy();
 }
 expect(calls).toEqual(['text','textarea','button','select']);
 for(const type of ['checkbox','file','hidden'])expect(nativeComponent(createUiElement(doc,'input',{type}))).toBeUndefined();
 expect(calls).toHaveLength(4);
});
it('uses browser controls without a runtime and fails visibly if an available native adapter is broken',()=>{
 const {doc}=fixture();expect(createUiElement(doc,'input',{type:'password'}).type).toBe('password');
 doc.defaultView.__ignisUiRuntime={controls:new WeakMap()};expect(()=>createUiElement(doc,'input')).toThrow();
});
