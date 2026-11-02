import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const { createI18n, catalog }=require('./web/i18n.js');
function fixture(language='en-US') {
 const values=new Map();
 const host={navigator:{languages:[language]},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}};
 return {host,values,i18n:createI18n(host)};
}
describe('Ignis UI languages',()=>{
 it('supports Spanish variants and English with a safe unsupported-language fallback',()=>{
  for(const language of ['es','es-ES','es-MX','ES_ar'])expect(fixture(language).i18n.t('Account')).toBe('Cuenta');
  for(const language of ['en','en-GB','fr','unexpected'])expect(fixture(language).i18n.t('Account')).toBe('Account');
 });
 it('keeps account preferences separate and respects the Obsidian language',()=>{
  const {i18n,values}=fixture('en-US');
  values.set('ignis-account-v1:alice:language','es');
  i18n.useAccount('alice');expect(i18n.language).toBe('es');
  i18n.useAccount('bob');expect(i18n.language).toBe('en');
  i18n.fromObsidian({getLanguage:()=> 'es'});expect(i18n.language).toBe('es');
  expect(values.get('ignis-account-v1:bob:language')).toBe('es');
  i18n.fromObsidian({getLanguage:()=> 'fr'});expect(i18n.language).toBe('en');
  expect(values.get('ignis-account-v1:bob:language')).toBe('fr');
  expect(values.get('ignis-account-v1:alice:language')).toBe('es');
 });
 it('persists the selector preference for the device and current account',()=>{
  const {i18n,host,values}=fixture();i18n.useAccount('alice');i18n.setLanguage('es');
  expect(createI18n(host).language).toBe('es');expect(values.get('ignis-account-v1:alice:language')).toBe('es');
  i18n.setLanguage('en');expect(i18n.t('Account')).toBe('Account');
 });
 it('works when browser storage is denied',()=>{
  const host={navigator:{language:'es'},get localStorage(){throw new Error('denied');}};
  const i18n=createI18n(host);i18n.useAccount('alice');i18n.setLanguage('en');expect(i18n.t('Account')).toBe('Account');
 });
 it('preserves untrusted names, replacement metacharacters and literal placeholder-looking text',()=>{
  const {i18n}=fixture('es');const name='<img src=x onerror=alert(1)> $& {p1}';
  expect(i18n.t('Signed in as {p0}.',{p0:name})).toContain(name);
  expect(i18n.t('Name not in catalog')).toBe('Name not in catalog');
  expect(i18n.t(' Account ')).toBe(' Cuenta ');
 });
 it('only translates explicitly marked interface elements, using textContent rather than HTML',()=>{
  const {host,i18n}=fixture('es');const translated={textContent:'Account',getAttribute:()=> 'Account'};
  const note={textContent:'Account'};
  host.document={documentElement:{},querySelector:()=>null,querySelectorAll:selector=>selector==='[data-i18n]'?[translated]:[]};
  i18n.applyStatic();expect(translated.textContent).toBe('Cuenta');expect(note.textContent).toBe('Account');expect(host.document.documentElement.lang).toBe('es');
 });
 it('contains no invented interpolation variables or empty translations',()=>{
  for(const [source,translation] of Object.entries(catalog)){
   expect(translation.trim(),source).not.toBe('');
   for(const placeholder of translation.match(/\{p\d+\}/g)||[])expect(source,source).toContain(placeholder);
  }
 });
 it('loads the common runtime before the standalone page controllers and the vault bootstrap',()=>{
  for(const name of ['login','setup','reset-password']){
   const page=fs.readFileSync(new URL(`./web/${name}.html`,import.meta.url),'utf8');
   expect(page.indexOf('/auth/i18n.js')).toBeGreaterThan(0);
   expect(page.indexOf('/auth/i18n.js')).toBeLessThan(page.indexOf(`/auth/${name}.js`));
  }
  const page=fs.readFileSync(new URL('../assets/index.html',import.meta.url),'utf8');
  expect(page.indexOf('/auth/i18n.js')).toBeLessThan(page.indexOf('/auth/client.js'));
 });
 it('does not translate protocol log prefixes used to classify sync events',()=>{
  const {i18n}=fixture('es');globalThis.IgnisI18n=i18n;
  try {const {kindOf}=require('../plugins/headless-sync/obsidian/src/sync-log-kinds.js');expect(kindOf('Uploading note.md')).toBe('upload');expect(kindOf('Deleting note.md')).toBe('deletion');}
  finally {delete globalThis.IgnisI18n;}
 });
});


it('carries the setup/login language through real sign-in cleanup into Obsidian account storage',async()=>{
 const {host,values,i18n:setup}=fixture('es-ES');
 setup.setLanguage('en');
 const login=createI18n(host);expect(login.language).toBe('en');
 host.IgnisI18n=login;
 values.set('cached-note','private');values.set('ignis-account-v1:old:language','es');
 const sessionValues=new Map([['private-session','secret']]);
 host.localStorage.clear=()=>values.clear();
 host.sessionStorage={clear:()=>sessionValues.clear(),getItem:key=>sessionValues.get(key)??null,setItem:(key,value)=>sessionValues.set(key,value),removeItem:key=>sessionValues.delete(key)};
 const source=fs.readFileSync(new URL('./web/login.js',import.meta.url),'utf8');
 const cleanupSource=source.slice(source.indexOf('  async function clearBrowserData('),source.indexOf('  const loginError ='));
 const clear=vm.runInNewContext(cleanupSource+';clearBrowserData;',{window:host,localStorage:host.localStorage,sessionStorage:host.sessionStorage});
 await clear(undefined,true);
 expect([...values.keys()].sort()).toEqual(['ignis-signin-language-v1','ignis-ui-language-v1']);
 expect(sessionValues.size).toBe(0);
 host.IgnisI18n=createI18n(host);host.__ignisAuth={userId:'alice',blocked:false};
 const {installAccountStorage}=await import('../../../../packages/shim/src/account-storage.js');
 installAccountStorage(host);
 expect(host.localStorage.getItem('language')).toBe('en');
 host.IgnisI18n.fromObsidian({getLanguage:()=>host.localStorage.getItem('language')});
 expect(host.IgnisI18n.language).toBe('en');expect(host.IgnisI18n.t('Account')).toBe('Account');
 expect(values.has('ignis-signin-language-v1')).toBe(false);
});
it('applies the selected language to the signing-in account only and consumes it once',()=>{
 const {host,values,i18n}=fixture('es-ES');
 values.set('ignis-account-v1:alice:language','es');
 i18n.setLanguage('en');i18n.rememberLanguage({forSignIn:true});
 const app=createI18n(host);app.useAccount('alice');expect(app.language).toBe('en');
 app.useAccount('bob');expect(app.language).toBe('es');
 expect(values.get('ignis-account-v1:alice:language')).toBe('en');
});
it('keeps only the UI language after logout and discards pending sign-in state',()=>{
 const {host,values,i18n}=fixture('es-ES');i18n.setLanguage('en');
 i18n.rememberLanguage({forSignIn:true});values.clear();i18n.rememberLanguage();
 expect([...values]).toEqual([['ignis-ui-language-v1','en']]);
 expect(createI18n(host).language).toBe('en');
});
it('ignores invalid language handoffs without replacing an existing Obsidian language',()=>{
 const {values,i18n}=fixture('es-ES');values.set('ignis-signin-language-v1','../../secret');values.set('ignis-account-v1:alice:language','fr');
 i18n.useAccount('alice');expect(i18n.language).toBe('en');expect(values.get('ignis-account-v1:alice:language')).toBe('fr');expect(values.has('ignis-signin-language-v1')).toBe(false);
});
