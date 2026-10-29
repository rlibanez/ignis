import {it,expect,vi} from "vitest";
import {createPrivateConflictNotice} from "./private-conflict-notice.js";
function fixture(){
 const elements=[];const listeners={};let current={sessionId:"s",vault:"v"};let blob;
 const host={addEventListener:(name,fn)=>{listeners[name]=fn;},URL:{createObjectURL:vi.fn(()=>"blob:test"),revokeObjectURL:vi.fn()},Blob:class{constructor(parts){blob=parts.join("");}},document:{createElement:tag=>{const element={tag,style:{},attrs:{},children:[],events:{},setAttribute(k,v){this.attrs[k]=v;},append(...children){this.children.push(...children);},addEventListener(k,v){this.events[k]=v;},click:vi.fn(),remove:vi.fn()};elements.push(element);return element;},body:{append:vi.fn()}}};
 return {host,elements,listeners,report:createPrivateConflictNotice(()=>current,host),switch:()=>{current={sessionId:"other",vault:"v"};},blob:()=>blob};
}
const event={sessionId:"s",vault:"v",path:".obsidian/app.json",content:'{"showLineNumber":true}',code:"PREFERENCES_CONFLICT"};
it("shows one persistent alert and downloads copies without injecting settings into HTML",()=>{
 const f=fixture();f.report(event);f.report({...event,path:".obsidian/workspace.json",content:'{"unsafe":"<script>"}'});
 expect(f.host.document.body.append).toHaveBeenCalledTimes(1);
 expect(f.elements[0].attrs.role).toBe("alert");
 f.elements.find(e=>e.tag==="button").events.click();
 const data=JSON.parse(f.blob());expect(data.files[event.path]).toBe(event.content);
 expect(data.files[".obsidian/workspace.json"]).toContain("<script>");
 expect(f.elements.some(e=>e.innerHTML)).toBe(false);
});
it("discards recovery data on session loss and checks context again before downloads",()=>{
 const f=fixture();f.report(event);f.switch();f.elements.find(e=>e.tag==="button").events.click();
 expect(f.host.URL.createObjectURL).not.toHaveBeenCalled();expect(f.elements[0].remove).toHaveBeenCalled();
 const g=fixture();g.report(event);g.elements.find(e=>e.tag==="button").events.click();g.listeners["ignis:auth-lost"]();
 expect(g.host.URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
});
it("ignores stale context and unsupported or oversized payloads",()=>{
 const f=fixture();f.report({...event,sessionId:"other"});f.report({...event,path:".obsidian/plugins/x.js"});f.report({...event,content:"a".repeat(1048577)});
 expect(f.host.document.body.append).not.toHaveBeenCalled();
});
