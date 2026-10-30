const express = require("express");
function createResourceSharesRouter(service) {
  const router = express.Router();
  const json = express.json({limit:service.limits.maxRequestBytes,strict:true});
  const messages = {
    SHARE_WRITE_UNCERTAIN:[503,"The file was published, but its sharing metadata could not be confirmed. Ask the owner to check the file and share it again."],
    INVALID_SHARE:[400,"Invalid share or recipient."], INVALID_SHARE_PATH:[400,"Choose a content file or folder; configuration cannot be shared."],
    SHARE_CONFLICT:[409,"This resource changed. Reload before trying again; your edits have not been saved."],
    SHARE_EXISTS:[409,"This resource is already shared. Manage its existing permissions."],
    SHARE_LIMIT:[413,"Too many resources or directory entries."], SHARE_TOO_LARGE:[413,`The file exceeds the ${service.limits.maxFileMiB} MiB limit.`],
  };
  const fields={create:"login,path,role,vault",grant:"action,id,login,revision,role",revoke:"action,id,revision",browse:"path,vault",read:"id,path",write:"action,content,etag,id,path",mkdir:"action,etag,id,path",remove:"action,etag,id,path"};
  router.get("/api/shares",(req,res)=>{
    try {if(Object.keys(req.query).length) return res.status(400).json({error:"Invalid request"});res.json(service.catalog(req.shareToken));}
    catch {res.status(404).json({error:"Shared resources unavailable"});}
  });
  router.post("/api/shares",(req,res,next)=>{
    if(!req.is("application/json")) return res.status(415).json({error:"JSON required"});
    json(req,res,error=>error?res.status(error.status===413?413:400).json({error:"Invalid request body"}):next());
  },async(req,res)=>{
    try {
      const {operation,input}=req.body || {};
      if(Object.keys(req.query).length || Object.keys(req.body).sort().join(",")!=="input,operation" || !input || Array.isArray(input) || typeof input!=="object" ||
        !Object.hasOwn(fields,operation) || Object.keys(input).sort().join(",")!==fields[operation])
        return res.status(400).json({error:"Invalid request"});
      if(["grant","revoke","write","mkdir","remove"].includes(operation) && input.action!==operation) return res.status(400).json({error:"Invalid request"});
      const fn={create:"create",grant:"grant",revoke:"grant",browse:"browseOwner",read:"read",write:"mutate",mkdir:"mutate",remove:"mutate"}[operation];
      res.json(await service[fn](req.shareToken,input));
    } catch(error) {
      const [status,message]=messages[error.code] || (error.code==="ENOTEMPTY"?[409,"The folder must be empty before removing it."]:[404,"Shared resource unavailable"]);
      res.status(status).json({error:message});
    }
  });
  return router;
}
module.exports={createResourceSharesRouter};
