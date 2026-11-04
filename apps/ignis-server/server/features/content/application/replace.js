const {validContentVersion}=require('../../../../../../packages/contracts/src/content');
function createContentReplacement({queue,publisher}) {
  async function replace({select,bytes,expectedHash,mode='replace',conflictCode='CONTENT_CONFLICT'}) {
    if(!validContentVersion(expectedHash))throw Object.assign(new Error('Invalid content version'),{code:'CONTENT_VERSION_REQUIRED'});
    const first=select();
    if(first.sourceItem && first.sourceItem.filename!==first.item.filename)await queue.flushPending(first.sourceItem.filename);
    await queue.flushPending(first.item.filename);
    return queue.supersedePending(first.item.filename,()=>{
      const fresh=select();
      // A rename while waiting must not move this write outside its serialization key.
      if(fresh.item.filename!==first.item.filename || fresh.vaultId!==first.vaultId || fresh.actorId!==first.actorId ||
        (fresh.sourceItem && (fresh.sourceItem.filename!==first.sourceItem?.filename || queue.getPending(fresh.sourceItem.filename)!==null)) ||
        queue.getPending(fresh.item.filename)!==null)
        throw Object.assign(new Error('Content changed'),{code:conflictCode});
      return publisher.replace({select,initial:fresh,bytes,expectedHash,mode,conflictCode});
    });
  }
  return Object.freeze({replace});
}
module.exports={createContentReplacement};
