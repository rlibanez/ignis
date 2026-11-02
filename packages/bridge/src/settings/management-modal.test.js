import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
vi.mock("obsidian",()=>({Modal:class {},setIcon:vi.fn()}));
import { ManagementModal } from "./management-modal.js";
afterEach(()=>vi.unstubAllGlobals());
it.each(["users","shares","login","password-visibility"])("registers %s without mounting into the vault document",name=>{
  const document=new Proxy({}, {get(){throw new Error("Unexpected access to the vault document");}});
  const context={window:{__ignisAuth:{role:"user"}},document};
  vm.runInNewContext(readFileSync(new URL(`../../../../apps/ignis-server/server/auth/web/${name}.js`,import.meta.url),"utf8"),context);
  expect(typeof context.IgnisManagementControllers[name]).toBe("function");
});
it("closes channels, aborts requests and erases sensitive fields when dismissed",()=>{
  const modal=new ManagementModal({},"users");
  const field={value:"temporary secret"};
  modal.contentEl={querySelectorAll:()=>[field],empty:vi.fn()};
  const channel={close:vi.fn()},cleanup=vi.fn();modal.channels.push(channel);modal.cleanups.push(cleanup);
  modal.onClose();
  expect(cleanup).toHaveBeenCalledOnce();expect(channel.close).toHaveBeenCalledOnce();
  expect(modal.abort.signal.aborted).toBe(true);expect(field.value).toBe("");expect(modal.contentEl.empty).toHaveBeenCalledOnce();
});
