import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
const {inspectSource}=createRequire(import.meta.url)('./import-source');
const file=path=>({path,kind:'file',size:1}),dir=path=>({path,kind:'directory',size:0});
it('keeps a root vault intact, including its ordinary folders',()=>{const result=inspectSource([dir('.obsidian'),file('Folder/Note.md')]);expect(result.vaults.map(v=>v.root)).toEqual(['']);expect(result.outside).toEqual([]);});
it('detects sibling vaults beneath a shared container, including empty Obsidian directories',()=>{const result=inspectSource([dir('Backup/A/.obsidian'),file('Backup/A/Note.md'),file('Backup/B/.obsidian/app.json'),file('Backup/B/Other.md'),file('Readme.md')]);expect(result.vaults.map(v=>v.root)).toEqual(['Backup/A','Backup/B']);expect(result.vaults[0].indexes).toEqual([0,1]);expect(result.outside.map(v=>v.path)).toEqual(['Readme.md']);});
it('does not split nested vaults and identifies the ambiguous roots explicitly',()=>{const result=inspectSource([dir('.obsidian'),dir('Nested/.obsidian')]);expect(result.vaults.map(v=>v.root)).toEqual(['']);expect(result.nested).toEqual(['Nested']);});
it('falls back to one vault without a marker and ignores files merely named .obsidian',()=>{expect(inspectSource([file('Note.md'),file('.obsidian')]).vaults.map(v=>v.root)).toEqual(['']);});
it('validates the entire source before splitting it, including unused paths and shared aggregate limits',()=>{for(const files of [[dir('A/.obsidian'),file('../outside')],[dir('A/.obsidian'),file('A/Note.md'),file('a/Other.md')],Array.from({length:9},(_,i)=>({path:`V${i}/Note`,size:512*1024*1024}))])expect(()=>inspectSource(files)).toThrow();});
it('bounds the number of detected vaults',()=>{expect(()=>inspectSource(Array.from({length:33},(_,i)=>dir(`Vault${i}/.obsidian`)))).toThrow();});

it('never promotes hidden or generated directories into vault roots',()=>{for(const path of ['.git/A/.obsidian','node_modules/A/.obsidian','__MACOSX/A/.obsidian'])expect(inspectSource([dir(path),file('Note.md')]).vaults.map(v=>v.root)).toEqual(['']);});
