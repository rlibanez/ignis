import {it,expect,vi,afterEach} from 'vitest';
import {createAccountSettings} from './account-settings.js';
afterEach(()=>vi.unstubAllGlobals());
it('sets account form button types explicitly even when native createEl ignores the type option',async()=>{
 const opened=[];
 const doc={getElementById:()=>true,head:{},defaultView:{Event}};
 class Element {
  constructor(tag='div',options={}){this.tagName=tag.toUpperCase();this.type=tag==='button'?'submit':options.type;this.children=[];this.ownerDocument=doc;this.classList={add(){}};this.events=new Map();}
  createEl(tag,options={}){const child=new Element(tag,options);this.children.push(child);return child;}
  createDiv(options){return this.createEl('div',options);}
  createSpan(options){return this.createEl('span',options);}
  addClass(){}setAttribute(){}removeAttribute(){}focus(){}
  addEventListener(type,handler){this.events.set(type,handler);}
 }
 class Modal {
  constructor(){this.contentEl=new Element();this.modalEl=new Element();}
  setTitle(){}open(){this.onOpen();opened.push(this);}
 }
 vi.stubGlobal('document',doc);vi.stubGlobal('window',{addEventListener(){}});
 vi.stubGlobal('fetch',vi.fn(async url=>({ok:true,json:async()=>url==='/api/auth/session'
  ? {sessionId:'test',user:{id:'a',login:'admin',role:'admin'},hasLocalPassword:true,oidcLinked:true,recentAuthentication:true,passwordPolicy:{minLength:8,minSpecialChars:0}}
  : {oidcAvailable:true,oidcButtonText:'Provider'}})));
 const {settingDefinitions}=createAccountSettings({Modal,Notice:class{},setIcon(){},ManagementModal:class{}});
 const tab={update:vi.fn()};settingDefinitions(tab);await vi.waitFor(()=>expect(tab.update).toHaveBeenCalledOnce());
 const definitions=settingDefinitions(tab).flatMap(group=>group.items);
 for(const name of ['Email','Change password','OpenID Connect']){
  let click;
  const button={setButtonText(){return this;},setWarning(){return this;},setDisabled(){return this;},onClick(handler){click=handler;return this;}};
  const setting={setDesc(){return this;},addButton(handler){handler(button);return this;}};
  definitions.find(item=>item.name===name).render(setting);click();
  const buttons=[];const visit=node=>{if(node.tagName==='BUTTON')buttons.push(node);node.children.forEach(visit);};visit(opened.at(-1).contentEl);
  expect(buttons.filter(el=>el.type==='submit')).toHaveLength(1);
  expect(buttons.filter(el=>el.type==='button').length).toBeGreaterThanOrEqual(2);
 }
});
