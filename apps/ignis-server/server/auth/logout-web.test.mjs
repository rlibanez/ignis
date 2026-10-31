import {it,expect,vi} from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./web/login.js',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('  let logoutConfirmed = false;'),source.indexOf('  async function start()'));
function fixture(request,clearBrowserData){
 let click;const logout={addEventListener:(name,fn)=>click=fn};
 const nodes={account:{hidden:false},'manage-account':{hidden:false}};
 const context={logout,request,clearBrowserData,form:{hidden:false},oidcButton:{hidden:false},linkButton:{hidden:false},document:{getElementById:id=>nodes[id]},status:{classList:{add:vi.fn()}},channel:{postMessage:vi.fn()},location:{replace:vi.fn()}};
 vm.runInNewContext(handler,context);return {...context,nodes,click:()=>click()};
}
it('reports confirmed logout separately from blocked storage and retries only cleanup',async()=>{
 const request=vi.fn(async()=>({ok:true})),clear=vi.fn().mockRejectedValueOnce(new Error('blocked')).mockResolvedValueOnce();
 const f=fixture(request,clear);await f.click();
 expect(f.status.textContent).toContain('You are signed out');expect(f.logout.textContent).toBe('Retry cleanup');expect(f.logout.disabled).toBe(false);
 expect(f.nodes.account.hidden).toBe(true);expect(f.form.hidden).toBe(true);expect(f.oidcButton.hidden).toBe(true);expect(f.location.replace).not.toHaveBeenCalled();expect(f.channel.postMessage).toHaveBeenCalledWith('lock');
 await f.click();expect(request).toHaveBeenCalledTimes(1);expect(clear).toHaveBeenCalledTimes(2);expect(f.location.replace).toHaveBeenCalledWith('/login');
});
it('does not claim logout or hide the account when server revocation failed',async()=>{
 const request=vi.fn().mockResolvedValueOnce({ok:false}).mockResolvedValueOnce({ok:true}),clear=vi.fn(async()=>{}),f=fixture(request,clear);
 await f.click();expect(f.status.textContent).toContain('Unable to confirm');expect(f.nodes.account.hidden).toBe(false);expect(clear).not.toHaveBeenCalled();expect(f.channel.postMessage).not.toHaveBeenCalled();
 await f.click();expect(request).toHaveBeenCalledTimes(2);expect(f.location.replace).toHaveBeenCalledWith('/login');
});
it('redirects only after successful revocation and successful cleanup',async()=>{
 const f=fixture(async()=>({ok:true}),async()=>{});await f.click();expect(f.location.replace).toHaveBeenCalledWith('/login');
});
