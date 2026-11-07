import {afterEach,expect,it,vi} from "vitest";
vi.mock("obsidian",()=>({Notice:class{},FuzzySuggestModal:class{}}));
import {registerCommands} from "./index.js";
afterEach(()=>vi.unstubAllGlobals());
it.each(["admin","user"])("registers workspace and owner refresh commands for %s",role=>{
 vi.stubGlobal("window",{__ignisAuth:{role},__ignis:{vault:{uuid:"v",membership:"owner"}}});
 const commands=[];registerCommands({addCommand:command=>commands.push(command)});
 expect(commands.map(command=>command.id)).toEqual(["open-workspace-in-new-tab","refresh-vault-from-disk"]);
});
it.each(["reader","editor"])("keeps workspace access but not owner refresh for %s",membership=>{
 vi.stubGlobal("window",{__ignisAuth:{role:"user"},__ignis:{vault:{uuid:"v",membership}}});
 const commands=[];registerCommands({addCommand:command=>commands.push(command)});
 expect(commands.map(command=>command.id)).toEqual(["open-workspace-in-new-tab"]);
});
it("does not register commands for a blocked session",()=>{
 vi.stubGlobal("window",{__ignisAuth:{role:"admin",blocked:true}});
 const addCommand=vi.fn();registerCommands({addCommand});expect(addCommand).not.toHaveBeenCalled();
});
