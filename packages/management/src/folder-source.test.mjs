import {it,expect} from 'vitest';
import {directoryFromDrop,readDirectory,folderFromFiles,zipFromDrop} from './folder-source.js';
const signal=()=>new AbortController().signal;
const file=name=>({name,isFile:true,isDirectory:false,file:resolve=>resolve(new File(['text'],name))});
function directory(name,batches){return {name,isDirectory:true,isFile:false,createReader(){let index=0;return {readEntries:resolve=>queueMicrotask(()=>resolve(batches[index++]||[]))};}};}
it('reads every legacy directory batch and preserves empty folders without showDirectoryPicker',async()=>{
 const first=Array.from({length:100},(_,i)=>file(`first-${i}.md`)),second=Array.from({length:50},(_,i)=>file(`last-${i}.md`));
 second.push(directory('Empty',[[]]));
 const root=directory('Original',[first,second,[]]);let capturing=true;
 const transfer={items:[{kind:'file',webkitGetAsEntry(){expect(capturing).toBe(true);return root;}}]};
 const pending=directoryFromDrop(transfer);capturing=false;
 const handle=await pending,entries=await readDirectory(handle,signal());
 expect(handle.name).toBe('Original');expect(entries.filter(e=>e.kind==='file')).toHaveLength(150);expect(entries).toContainEqual({path:'Empty',kind:'directory',size:0});
 expect(entries.find(e=>e.path==='last-49.md').file.size).toBe(4);
});
it('reads nested legacy directories and a completely empty selected root',async()=>{
 const root=directory('Original',[[directory('Parent',[[directory('Empty',[[]]),file('Note.md')],[]])],[]]);
 const handle=await directoryFromDrop({items:[{kind:'file',getAsEntry:()=>root}]});
 expect((await readDirectory(handle,signal())).map(e=>e.path)).toEqual(['Parent','Parent/Empty','Parent/Note.md']);
 const empty=await directoryFromDrop({items:[{kind:'file',getAsEntry:()=>directory('Empty',[[]])}]});expect(await readDirectory(empty,signal())).toEqual([]);
});
it('supports modern dropped directory handles and starts reading during the drop event',async()=>{
 let capturing=true;const root={name:'Original',kind:'directory',async *values(){yield {name:'Empty',kind:'directory',async *values(){}};}};
 const pending=directoryFromDrop({items:[{kind:'file',getAsFileSystemHandle(){expect(capturing).toBe(true);return Promise.resolve(root);}}]});capturing=false;
 expect(await readDirectory(await pending,signal())).toEqual([{path:'Empty',kind:'directory',size:0}]);
});
it('rejects loose files, multiple roots and unreadable folders without a lossy FileList fallback',async()=>{
 for(const transfer of [{items:[]},{items:[{kind:'file',webkitGetAsEntry:()=>file('Note.md')}]},{items:[{kind:'file'},{kind:'file'}]},{items:[{kind:'file',getAsFile:()=>new File(['text'],'Note.md')}]}])await expect(directoryFromDrop(transfer)).rejects.toThrow();
 const root={name:'Unreadable',isDirectory:true,createReader:()=>({readEntries:(resolve,reject)=>reject(Error('permission denied'))})};
 await expect(readDirectory(await directoryFromDrop({items:[{kind:'file',getAsEntry:()=>root}]}),signal())).rejects.toThrow('permission denied');
});
it('stops enumeration after cancellation',async()=>{
 const abort=new AbortController();abort.abort();const root=directory('Original',[[file('Note.md')]]);
 await expect(readDirectory(await directoryFromDrop({items:[{kind:'file',getAsEntry:()=>root}]}),abort.signal)).rejects.toHaveProperty('name','AbortError');
});

it('accepts traditional folder selections and reconstructs nonempty parent directories',()=>{
 const files=['Original/Note.md','Original/Folder/Nested.md'].map(relative=>{const file=new File(['text'],relative.split('/').pop());Object.defineProperty(file,'webkitRelativePath',{value:relative});return file;});
 const selected=folderFromFiles(files);expect(selected.name).toBe('Original');expect(selected.entries.map(e=>[e.path,e.kind])).toEqual([['Note.md','file'],['Folder','directory'],['Folder/Nested.md','file']]);
 expect(selected.entries[2].file).toBe(files[1]);
 expect(()=>folderFromFiles([])).toThrow();expect(()=>folderFromFiles([new File(['text'],'No paths')])).toThrow();
 const other=new File(['text'],'Other.md');Object.defineProperty(other,'webkitRelativePath',{value:'Other/Other.md'});expect(()=>folderFromFiles([...files,other])).toThrow();
});
it('accepts one dropped ZIP and rejects directories, multiple files and unsupported files',()=>{
 const archive=new File(['zip'],'Vault.zip');expect(zipFromDrop({items:[{kind:'file',getAsFile:()=>archive}]})).toBe(archive);
 expect(zipFromDrop({files:[archive]})).toBe(archive);
 expect(()=>zipFromDrop({items:[{kind:'file',webkitGetAsEntry:()=>({isDirectory:true}),getAsFile:()=>archive}]})).toThrow();
 expect(()=>zipFromDrop({files:[archive,archive]})).toThrow();expect(()=>zipFromDrop({files:[new File(['text'],'Note.md')]})).toThrow();expect(()=>zipFromDrop({files:[]})).toThrow();
});
