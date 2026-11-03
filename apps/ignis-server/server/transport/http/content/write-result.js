const {writeOutcome}=require('../../../../../../packages/contracts/src/content');
function sendWriteFailure(res,error){
  let outcome=error.outcome || writeOutcome(error),code=error.code;
  if(outcome==='conflict')return res.status(code==='CONTENT_VERSION_REQUIRED'?428:409).json({error:'The file changed or its version is invalid. Preserve your changes before reloading.',code,outcome});
  if(outcome==='denied')return res.status(404).json({error:'Resource unavailable',code:'CONTENT_UNAVAILABLE',outcome});
  // Only the publisher can assert that a failure happened before publication.
  // Legacy/configuration I/O failures may already have modified bytes.
  if(outcome==='uncertain' || error.outcome!=='failed'){
    outcome='uncertain';code='CONTENT_WRITE_UNCERTAIN';
    return res.status(503).json({error:'The save could not be confirmed. Preserve your changes before reloading.',code,outcome});
  }
  return res.status(500).json({error:'The file could not be saved.',code:['ENOSPC','EACCES','EIO','EROFS'].includes(code)?code:'CONTENT_WRITE_FAILED',outcome:'failed'});
}
module.exports={sendWriteFailure};
