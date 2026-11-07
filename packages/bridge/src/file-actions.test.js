import {afterEach,expect,it,vi} from "vitest";
vi.mock("obsidian",()=>({Notice:class{}}));
import {addFileMenuItems,addFolderMenuItems} from "./file-actions.js";
afterEach(()=>vi.unstubAllGlobals());
function menu(){const items=[];return {items,addItem(fn){const item={setTitle(title){this.title=title;return this;},setIcon(){return this;},setSection(){return this;},onClick(fn){this.click=fn;return this;}};items.push(item);fn(item);}};}
it.each([false,true])("uses sharing downloads for received resources (directory: %s)",directory=>{
 const anchor={click:vi.fn()};const downloadUrl=vi.fn(()=>"/api/shares/content?id=share&path=note&context=session"+(directory?"&archive=1":""));
 vi.stubGlobal("window",{__ignis:{vault:{uuid:"v"},sharedFiles:{downloadUrl}}});
 vi.stubGlobal("document",{createElement:()=>anchor});
 const m=menu(),file={path:"received/Note",name:"Note"};
 if(directory)addFolderMenuItems(m,file,{});else addFileMenuItems(m,file);
 m.items[0].click();expect(downloadUrl).toHaveBeenCalledWith(file.path,directory);
 expect(anchor.href).toContain("/api/shares/content?");expect(anchor.click).toHaveBeenCalledOnce();
});
it("keeps ordinary downloads pinned to the current vault UUID",()=>{
 const anchor={click:vi.fn()};vi.stubGlobal("window",{__ignis:{vault:{uuid:"uuid"},sharedFiles:{downloadUrl:()=>null}}});vi.stubGlobal("document",{createElement:()=>anchor});
 const m=menu();addFileMenuItems(m,{path:"Own.md",name:"Own.md"});m.items[0].click();
 expect(anchor.href).toBe("/api/fs/download?vault=uuid&path=Own.md");
});
