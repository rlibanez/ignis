import {it,expect} from 'vitest';
import environment from './ui-environment.cjs';
import {fixture} from './ui-fixture.test-helper.js';
it('selects one mobile interaction mode and preserves it through rotation',()=>{
 const {doc}=fixture();doc.documentElement={style:{}};
 let dark=false,listener;const host={document:doc,innerWidth:390,matchMedia:query=>query==='(pointer: coarse)'?{matches:true}:{get matches(){return dark;},addEventListener(name,fn){listener=fn;},removeEventListener(){listener=null;}}};
 const dispose=environment.initialize(host);expect(doc.body.classList.contains('is-mobile')).toBe(true);
 host.innerWidth=844;dark=true;listener();expect(doc.body.classList.contains('is-mobile')).toBe(true);expect(doc.body.classList.contains('theme-dark')).toBe(true);
 dispose();expect(listener).toBe(null);
});
it('uses the same startup threshold as the editor and recognizes a landscape touch device',()=>{
 const {doc}=fixture();const host={document:doc,innerWidth:640,matchMedia:()=>({matches:false})};
 expect(environment.mobile(host)).toBe(false);host.innerWidth=599;expect(environment.mobile(host)).toBe(true);
 host.innerWidth=844;host.matchMedia=()=>({matches:true});expect(environment.mobile(host)).toBe(true);
});
