import {it,expect} from "vitest";
import {createRequire} from "node:module";
const {projectWorkspace}=createRequire(import.meta.url)("./workspace-config");
const leaf=(id,file="Notes/Welcome.md")=>({id,type:"leaf",state:{type:"markdown",state:{file,mode:"source",source:false,html:"secret"},plugin:"code"}});
it("projects the basic layout and only reviewed view state",()=>{
 const input={main:{id:"main",type:"split",direction:"vertical",children:[{id:"tabs",type:"tabs",children:[leaf("note")],currentTab:0}]},active:"note",lastOpenFiles:["private.md"],floating:{url:"https://evil.invalid"}};
 const result=projectWorkspace(input);
 expect(result.main.children[0].children[0]).toEqual({id:"note",type:"leaf",state:{type:"markdown",state:{file:"Notes/Welcome.md",mode:"source",source:false}}});
 expect(result.active).toBe("note");expect(result.lastOpenFiles).toBeUndefined();expect(result.floating).toBeUndefined();
});
it("drops plugin views, hidden or external paths and their active references",()=>{
 for(const file of ["../secret",".obsidian/app.json","/outside.md","https://evil.invalid","C:\\secret","folder//note.md","folder/.private.md"]){
  expect(projectWorkspace({main:leaf("note",file),active:"note"})).toEqual({});
 }
 expect(projectWorkspace({main:{id:"custom",type:"leaf",state:{type:"plugin-view",state:{code:"x"}}},active:"custom"})).toEqual({});
});
it("bounds depth and count, rejects duplicate IDs and clamps dimensions by omission",()=>{
 let deep=leaf("bottom");for(let i=0;i<20;i++)deep={id:"n"+i,type:"tabs",children:[deep]};
 const result=projectWorkspace({main:deep,active:"bottom"});expect(result.active).toBeUndefined();
 const duplicate=projectWorkspace({main:{id:"root",type:"tabs",dimension:Infinity,children:[leaf("a"),leaf("a")]}});
 expect(duplicate.main.children).toHaveLength(1);expect(duplicate.main.dimension).toBeUndefined();
});
