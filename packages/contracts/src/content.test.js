import {createRequire} from 'node:module';
const {validContentVersion,writeOutcome}=createRequire(import.meta.url)('./content');
import {it,expect} from 'vitest';
it('distinguishes deliberate replacement, create-only and exact versions',()=>{
 for(const version of [undefined,null,'a'.repeat(64)])expect(validContentVersion(version)).toBe(true);
 for(const version of ['',false,{},'*','A'.repeat(64),'a'.repeat(63)])expect(validContentVersion(version)).toBe(false);
});
it.each([['CONTENT_CONFLICT','conflict'],['CONTENT_WRITE_UNCERTAIN','uncertain'],['SHARE_WRITE_UNCERTAIN','uncertain'],['EACCES','denied'],['CONTENT_UNAVAILABLE','denied'],['ENOSPC','failed']])('classifies %s without pretending uncertain writes failed', (code,outcome)=>{
 expect(writeOutcome({code})).toBe(outcome);
});
