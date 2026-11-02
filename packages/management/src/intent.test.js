import {it,expect,vi} from 'vitest';
import {readManagementIntent,consumeManagementIntent} from './intent.js';
it.each(['account','users','shares','password','email'])('accepts only the fixed %s destination',kind=>{
 expect(readManagementIntent('?manage='+kind)).toBe(kind);
});
it.each(['','?manage=https://evil.invalid','?manage=../admin','?manage=delete-user'])('ignores invalid management destinations: %s',search=>{
 expect(readManagementIntent(search)).toBe(null);
});
it('opens the intended view once and preserves the selected vault when removing return parameters',()=>{
 const open=vi.fn(),history={replaceState:vi.fn()},host={location:{search:'?vault=uuid&manage=users&reauth=success',href:'https://example.test/?vault=uuid&manage=users&reauth=success'},history,sessionStorage:{getItem:()=>null,removeItem:vi.fn()}};
 consumeManagementIntent(host,open);expect(open).toHaveBeenCalledExactlyOnceWith('users');expect(history.replaceState).toHaveBeenCalledWith(null,'','/?vault=uuid');
});
it('restores only whitelisted login intents without accepting a redirect URL',()=>{
 for(const [saved,expected] of [['users','users'],['link','account'],['https://evil.invalid',null]]){
  const open=vi.fn(),removeItem=vi.fn(),host={location:{search:'',href:'https://example.test/'},history:{replaceState:vi.fn()},sessionStorage:{getItem:()=>saved,removeItem}};
  consumeManagementIntent(host,open);expect(removeItem).toHaveBeenCalledWith('ignis-reauth-return');
  if(expected)expect(open).toHaveBeenCalledWith(expected);else expect(open).not.toHaveBeenCalled();
 }
});
