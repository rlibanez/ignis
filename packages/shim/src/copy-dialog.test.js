import {it,expect} from 'vitest';
import {copyDestinationFolders,copyDestinationPath,copyFolderTree} from './copy-dialog.js';
it('offers folders but excludes source descendants, hidden state and read-only mounts',()=>{
 const files=['Work','Work/Sub','Received','Received/Sub','ReadOnly','.obsidian','Source','Source/Sub'].map(path=>({path,children:[]}));
 files.push({path:'note.md'});
 expect(copyDestinationFolders(files,'Source',path=>path==='ReadOnly'?{role:'reader'}:null).map(f=>f.path)).toEqual(['Received','Received/Sub','Work','Work/Sub']);
});
it('builds a destination from a selected folder and a name, never from typed traversal',()=>{
 expect(copyDestinationPath('Work','Note.md')).toBe('Work/Note.md');expect(copyDestinationPath('','Note.md')).toBe('Note.md');
 for(const name of ['','../file','a/b','a\\b','.env',' name','name.'])expect(()=>copyDestinationPath('Work',name)).toThrow();
});

it('does not list Obsidian root as an unnamed child folder',()=>{
 const files=[{path:'/',name:'',children:[]},{path:'',name:'',children:[]},{path:'Notes',name:'Notes',children:[]}];
 expect(copyDestinationFolders(files,'note.md',()=>null).map(f=>f.path)).toEqual(['Notes']);
});

it('expands folders independently and keeps collapsed descendants hidden',()=>{
 const folders=['A','A/Sub','A/Sub/Deep','B'].map(path=>({path,name:path.split('/').pop()}));
 expect(copyFolderTree(folders,new Set([''])).map(r=>r.path)).toEqual(['A','B']);
 expect(copyFolderTree(folders,new Set(['','A'])).map(r=>r.path)).toEqual(['A','A/Sub','B']);
 expect(copyFolderTree(folders,new Set()).length).toBe(0);
});
it('searches paths with ancestor context without changing expansion preferences',()=>{
 const folders=['A','A/Sub','A/Sub/Deep','B'].map(path=>({path})),expanded=new Set(['']);
 expect(copyFolderTree(folders,expanded,'deep').map(r=>r.path)).toEqual(['A','A/Sub','A/Sub/Deep']);
 expect(copyFolderTree(folders,expanded,'missing')).toEqual([]);
 expect(copyFolderTree(folders,expanded,'').map(r=>r.path)).toEqual(['A','B']);expect([...expanded]).toEqual(['']);
});
