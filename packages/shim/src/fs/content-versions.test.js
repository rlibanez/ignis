import {it,expect} from 'vitest';
import {contentHash} from './content-versions.js';
it('hashes the exact UTF-8 editor baseline, including empty and non-ASCII text',()=>{
 expect(contentHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
 expect(contentHash('ñ🙂')).toBe(contentHash(new TextEncoder().encode('ñ🙂')));
 expect(contentHash('a\r\nb')).not.toBe(contentHash('a\nb'));
});
