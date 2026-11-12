// Conservative export defaults for the browser Blob download. The import
// policy overrides byte bounds for its disk-backed streaming pipeline.
const limits=Object.freeze({files:10000,fileBytes:32*1024*1024,totalBytes:256*1024*1024,zipBytes:64*1024*1024,concurrent:4});
const maxVaults = 32;
function portablePath(value){
 if(typeof value!=='string'||!value||value.length>1024||value.split('/').length>32)return null;
 // Reject dangerous paths even when their content would otherwise be excluded.
 // eslint-disable-next-line no-control-regex
 if(/[\\:\x00-\x1f\x7f]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>255||/[. ]$/.test(p)||/^[<>"*?|]|[<>"*?|]/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))return null;
 return value.normalize('NFC');
}
function excludedTransferSegment(name){
 const part=name.toLowerCase();
 return part.startsWith('.ignis')||['.git','.trash','node_modules','__macosx'].includes(part);
}
module.exports={limits,maxVaults,portablePath,excludedTransferSegment};
