import {installEditorSaves as install1144} from './1.14.4/editor-saves.js';
export function installEditorSaves(obsidian,app,write,context,recover,{version}={}) {
  if(version!=='1.14.4')throw Object.assign(new Error('Unsupported Obsidian editor version'),{code:'OBSIDIAN_VERSION_UNSUPPORTED'});
  return install1144(obsidian,app,write,context,recover);
}
