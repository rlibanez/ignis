import {it,expect,vi,afterEach} from 'vitest';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{currentVaultId}=require('./vault-identity'),api=require('./api');
afterEach(()=>vi.unstubAllGlobals());
it('keeps the namespaced sync identity separate from the native display name and sends the pinned UUID',async()=>{
 vi.stubGlobal('window',{__ignis:{vault:{id:'roberto/pensadero',uuid:'opened-uuid'}},app:{vault:{getName:()=> 'pensadero'}}});
 expect(currentVaultId()).toBe('roberto/pensadero');
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({})});vi.stubGlobal('fetch',fetch);
 await api.startSync(currentVaultId());expect(JSON.parse(fetch.mock.calls[0][1].body).vaultId).toBe('opened-uuid');
 await api.getLogs(currentVaultId());expect(fetch.mock.calls.at(-1)[0]).toContain('vaultId=opened-uuid');
 window.__ignis.vault={id:'other/pensadero',uuid:'other-uuid'};expect(currentVaultId()).toBe('other/pensadero');
});
it('never substitutes a visible name when the internal identity is missing',()=>{
 vi.stubGlobal('window',{app:{vault:{getName:()=> 'pensadero'}}});expect(()=>currentVaultId()).toThrow('Authenticated vault identity required');
});
