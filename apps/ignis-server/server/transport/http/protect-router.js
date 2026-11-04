const protectedHandlers=new WeakSet();

// Express 4 catches synchronous throws, but does not observe returned promises.
// This wrapper handles rejections without adding lifecycle tracking: a vault
// rename/delete must never wait for its own handler to finish.
function protectRouter(router) {
  for(const layer of router.stack) {
    if(layer.handle?.stack)protectRouter(layer.handle);
    for(const entry of layer.route?.stack || []) {
      const handler=entry.handle;
      if(protectedHandlers.has(handler) || handler.length===4)continue;
      entry.handle=function(req,res,next) {
        try {return Promise.resolve(handler(req,res,next)).catch(next);}
        catch(error){return next(error);}
      };
      protectedHandlers.add(entry.handle);
    }
  }
  return router;
}
module.exports={protectRouter};
