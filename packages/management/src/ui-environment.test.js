import {it,expect} from 'vitest';
import environment from './ui-environment.cjs';
import {fixture} from './ui-fixture.test-helper.js';
it('preserves the selected interaction mode and external theme through rotation',()=>{
 const {doc}=fixture();doc.documentElement={style:{}};
 const data=new Map();
 const host={document:doc,innerWidth:390,matchMedia:query=>({matches:query==='(pointer: coarse)'}),
  localStorage:{getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),clear:()=>data.clear()}};
 const dispose=environment.initialize(host);
 expect(doc.body.classList.contains('is-mobile')).toBe(true);
 expect(environment.theme(host)).toBe('dark');
 expect(environment.setTheme(host,'light')).toBe(true);
 environment.clearBrowserPreferences(host);
 host.innerWidth=844;
 environment.applyTheme(host);
 expect(doc.body.classList.contains('is-mobile')).toBe(true);
 expect(doc.body.classList.contains('theme-light')).toBe(true);
 dispose();
});
it('uses the same startup threshold as the editor and recognizes a landscape touch device',()=>{
 const {doc}=fixture();const host={document:doc,innerWidth:640,matchMedia:()=>({matches:false})};
 expect(environment.mobile(host)).toBe(false);host.innerWidth=599;expect(environment.mobile(host)).toBe(true);
 host.innerWidth=844;host.matchMedia=query=>({matches:query==='(pointer: coarse)'});expect(environment.mobile(host)).toBe(true);
});

it.each(['phone','tablet','desktop'])('applies the Android %s preference to entry and terminal views', selected=>{
 const {doc}=fixture();
 const host={document:doc,innerWidth:390,__ignisAndroidInterfaceMode:selected,matchMedia:()=>({matches:true})};
 environment.applyMode(host,environment.mode(host,{inherit:false}));
 expect(doc.body.classList.contains('is-mobile')).toBe(selected!=='desktop');
 expect(doc.body.classList.contains('is-phone')).toBe(selected==='phone');
 expect(doc.body.classList.contains('is-tablet')).toBe(selected==='tablet');
});
it('detects tablet in a browser and Android using the same size threshold',()=>{
 const host={innerWidth:1180,matchMedia:()=>({matches:true})};
 expect(environment.mode(host)).toBe('tablet');
 expect(environment.mode({...host,__ignisAndroidInterfaceMode:'auto'})).toBe('tablet');
 expect(environment.mode({...host,matchMedia:query=>({matches:query.includes('min-height')})})).toBe('desktop');
});

it('offers device settings in Android and iOS browsers, including iPad desktop user agents',()=>{
 for(const navigator of [
  {userAgent:'Mozilla/5.0 (Linux; Android 14)'},
  {userAgent:'Mozilla/5.0 (iPhone)'},
  {userAgent:'Mozilla/5.0 (Macintosh)',platform:'MacIntel',maxTouchPoints:5},
 ])expect(environment.hasWebDeviceSettings({navigator})).toBe(true);
 expect(environment.hasWebDeviceSettings({navigator:{userAgent:'Android'},__ignisAndroidInterfaceMode:'auto'})).toBe(false);
 expect(environment.hasWebDeviceSettings({navigator:{userAgent:'Mozilla/5.0 (X11; Linux)'}})).toBe(false);
});

it('uses Android as the source of truth when the bridge is present',()=>{
 const host={__ignisAndroidExternalTheme:'light',prompt:(action,value)=>action==='IgnisAndroid:external-theme'?value:null};
 expect(environment.theme(host)).toBe('light');
 expect(environment.setTheme(host,'dark')).toBe(true);
 expect(environment.theme(host)).toBe('dark');
});

it.each([
 ['raw',null,'ignis-account-v1:alice:'],
 ['scoped','alice',''],
])('keeps only valid account-and-vault plugin decisions when clearing %s storage',(_kind,account,prefix)=>{
 const trusted=prefix+'enable-plugin-ignis-v1:alice:vault-a';
 const restricted=prefix+'enable-plugin-ignis-v1:alice:vault-b';
 const data=new Map([[trusted,'true'],[restricted,'false'],
  [prefix+'enable-plugin-ignis-v1:bob:vault-a','true'],
  [prefix+'enable-plugin-ignis-v1:alice:vault-c','invalid'],
  ['enable-plugin-Legacy','true'],['workspace','private']]);
 const localStorage={
  get length(){return data.size;},
  key:index=>[...data.keys()][index],
  getItem:key=>data.get(key),
  setItem:(key,value)=>data.set(key,value),
  clear:()=>data.clear(),
 };
 environment.clearBrowserPreferences({localStorage,__ignisAuth:{userId:account}});
 expect([...data]).toEqual([[trusted,'true'],[restricted,'false']]);
});
