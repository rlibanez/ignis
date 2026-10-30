import {it,expect,vi} from 'vitest';
import {createContentVersions,contentHash} from './content-versions.js';
function fixture(){const ctx={sessionId:'one',vault:'v'},failure=vi.fn();return {ctx,failure,v:createContentVersions(()=>ctx,failure)};}
it('pins a first read despite background refresh and advances only after an acknowledged save',()=>{
 const {v}=fixture();v.remember('n.md','base');v.remember('n.md','remote');
 const op=v.begin('n.md');expect(op.expectedHash).toBe(contentHash('base'));v.complete(op,contentHash('mine'));
 v.remember('n.md','remote2');expect(v.begin('n.md').expectedHash).toBe(contentHash('mine'));
});
it('pins cached bytes before optimistic mutation and requires absence for blind creates',()=>{
 const {v}=fixture();v.prepare('n.md','cached');v.remember('n.md','optimistic');expect(v.begin('n.md').expectedHash).toBe(contentHash('cached'));
 v.prepare('new.md');v.remember('new.md','optimistic');expect(v.begin('new.md').expectedHash).toBe(null);
});
it('retains text and binary drafts and rejects retries after a lost response',()=>{
 const {v,failure}=fixture();v.remember('n.md','base');const op=v.begin('n.md');
 expect(()=>v.rejected('n.md','draft',new Error('lost'),op)).toThrow();expect(failure).toHaveBeenCalledWith(expect.objectContaining({content:'draft',sessionId:'one'}));
 v.remember('n.md','new remote');expect(()=>v.begin('n.md')).toThrow();
 const binary=new Uint8Array([0,255,128]);expect(()=>v.rejected('image.png',binary,new Error('lost'),v.begin('image.png'))).toThrow();
 expect(failure.mock.calls.at(-1)[0]).toMatchObject({content:'AP+A',binary:true});
});
it('rejects a simultaneous save and preserves baselines through rename without recreating the old path',()=>{
 const {v}=fixture();v.remember('dir/n.md','base');const op=v.begin('dir/n.md');expect(()=>v.begin('dir/n.md')).toThrow();v.complete(op,contentHash('saved'));
 v.moved('dir','moved');expect(v.begin('moved/n.md').expectedHash).toBe(contentHash('saved'));expect(()=>v.begin('dir/n.md')).toThrow();
 v.removed('moved/n.md');expect(v.begin('moved/n.md').expectedHash).toBe(null);
});
it('does not transfer baselines or recovery copies to another session or vault',()=>{
 const {v,ctx,failure}=fixture();v.remember('n.md','private');const op=v.begin('n.md');ctx.sessionId='two';v.prepare('n.md');
 expect(()=>v.rejected('n.md','secret',new Error('lost'),op)).toThrow();expect(failure).not.toHaveBeenCalled();expect(v.begin('n.md').expectedHash).toBe(null);
 ctx.vault='other';expect(v.begin('n.md').expectedHash).toBe(null);
});
it('keeps shared configuration on its existing write contract',()=>{const {v}=fixture();expect(v.begin('.obsidian/plugins/a/data.json')).toBe(null);});

it('does not acknowledge an old response after switching accounts',()=>{
 const {v,ctx}=fixture();const op=v.begin('new.md');ctx.sessionId='two';expect(()=>v.complete(op,contentHash('secret'))).toThrow();
 expect(v.begin('new.md').expectedHash).toBe(null);
});
