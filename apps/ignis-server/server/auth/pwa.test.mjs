import {it,expect} from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('./web/pwa.js',import.meta.url),'utf8');
function start(standalone=false){
 const events={},button={hidden:true,disabled:false},document={querySelectorAll:()=>[button],addEventListener:(name,fn)=>{events[name]=fn;}};
 const window={isSecureContext:true,navigator:{},matchMedia:()=>({matches:standalone,addEventListener(){}}),addEventListener:(name,fn)=>{events[name]=fn;}};
 vm.runInNewContext(source,{window,document});return {events,button};
}
it('shows installation only after a browser offer and consumes it once',async()=>{
 const {events,button}=start();expect(button.hidden).toBe(true);let calls=0;
 events.beforeinstallprompt({preventDefault(){},prompt:async()=>{calls++;},userChoice:Promise.resolve({outcome:'dismissed'})});expect(button.hidden).toBe(false);
 const click={target:{closest:()=>button}};await events.click(click);await events.click(click);expect(calls).toBe(1);expect(button.hidden).toBe(true);expect(button.disabled).toBe(false);
});
it('does not offer installation in standalone mode',()=>{const {events,button}=start(true);events.beforeinstallprompt({preventDefault(){throw new Error('unexpected');}});expect(button.hidden).toBe(true);});
it('clears an offer after installation',()=>{const {events,button}=start();events.beforeinstallprompt({preventDefault(){}});events.appinstalled();expect(button.hidden).toBe(true);});
