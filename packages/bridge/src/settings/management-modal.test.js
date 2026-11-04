import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("obsidian",()=>({Modal:class {},setIcon:vi.fn()}));
import { ManagementModal } from "./management-modal.js";
afterEach(()=>vi.unstubAllGlobals());
it("does not expose page controllers or document proxies",()=>{
  const source=readFileSync(new URL("../../../management/src/management-modal.js",import.meta.url),"utf8");
  expect(source).not.toMatch(/IgnisManagementControllers|new Proxy|DOMParser|apps\/ignis-server/);
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
