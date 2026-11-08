import {showManagementNotice} from "../../management/src/ui-notice.js";
import {installUiLayout} from "../../management/src/ui-layout.js";
import {createUiElement} from "../../management/src/ui-controls.js";
import {Modal,Notice,TextComponent,TextAreaComponent,DropdownComponent,ButtonComponent,Menu,setIcon} from 'obsidian';
// Only exported component classes. The shell never imports the Obsidian runtime.
export function installUiRuntime(app,host=window) {
 installUiLayout(host.document);
 const previous=host.__ignisUiRuntime;
 const controls=new WeakMap();
 const runtime={showNotice:(...args)=>showManagementNotice(Notice,...args),controls,componentFor:element=>controls.get(element),createElement:(document,tag,options)=>createUiElement(document,tag,options),app,Modal,Notice,TextComponent,TextAreaComponent,DropdownComponent,ButtonComponent,Menu,setIcon};
 for(const name of ['Modal','TextComponent','TextAreaComponent','DropdownComponent','ButtonComponent'])
  if(typeof runtime[name]!=='function')throw Error('Required Obsidian UI component unavailable: '+name);
 host.__ignisUiRuntime=runtime;
 return ()=>{if(host.__ignisUiRuntime===runtime){if(previous)host.__ignisUiRuntime=previous;else delete host.__ignisUiRuntime;}};
}
