import {afterEach,it,expect,vi} from 'vitest';
import {pathShim} from './path.js';
afterEach(()=>vi.unstubAllGlobals());
it.each(['roberto/pensadero','alice/Personal.md','Notes'])('displays only the vault name at the virtual root for %s',directory=>{
 vi.stubGlobal('window',{__currentVaultId:directory});
 expect(pathShim.basename('/')).toBe(directory.split('/').pop());
 expect(window.__currentVaultId).toBe(directory);
});
it('preserves ordinary file basename and extension handling',()=>{
 vi.stubGlobal('window',{__currentVaultId:'roberto/pensadero'});
 expect(pathShim.basename('/folder/Note.md')).toBe('Note.md');
 expect(pathShim.basename('/alice/Personal')).toBe('Personal');
 expect(pathShim.basename('/folder/Note.md','.md')).toBe('Note');
});
