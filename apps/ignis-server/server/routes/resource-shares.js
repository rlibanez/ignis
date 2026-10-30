const express = require("express");
function createResourceSharesRouter(service) {
  const router = express.Router();
  const json = express.json({limit:service.limits.maxRequestBytes,strict:true});
  const messages = {
    SHARE_DELETE_UNCERTAIN:[503,"The resource was removed from its original location, but cleanup could not be confirmed. Ask the administrator to check the server."],
    SHARE_MOVE_BOUNDARY:[409,"Move within the same shared folder without crossing another shared folder boundary."],
    SHARE_PLACEMENT_CONFLICT:[409,"This location overlaps a local file or another shared resource. Choose another existing destination folder."],
    SHARE_RENAME_UNCERTAIN:[503,"The rename reached disk but its sharing metadata could not be confirmed. Ask the owner to check the resource before continuing."],
    SHARE_WRITE_UNCERTAIN:[503,"The file was published, but its sharing metadata could not be confirmed. Ask the owner to check the file and share it again."],
    INVALID_SHARE:[400,"Invalid share or recipient."], INVALID_SHARE_PATH:[400,"Choose a content file or folder; configuration cannot be shared."],
    SHARE_CONFLICT:[409,"This resource changed. Reload before trying again; your edits have not been saved."],
    SHARE_EXISTS:[409,"This resource is already shared. Manage its existing permissions."],
    SHARE_LIMIT:[413,"Too many resources or directory entries."], SHARE_TOO_LARGE:[413,`The file exceeds the ${service.limits.maxFileMiB} MiB limit.`],
  };
  const fields={previewRemoval:"id,path",removeConfirmed:"confirm,id,path,revision",mounts:"vault",destination:"id,localPath,vault",rename:"etag,id,path,to",create:"login,path,role,vault",grant:"action,id,login,revision,role",revoke:"action,id,revision",browse:"path,vault",read:"id,path",write:"action,content,etag,id,path",mkdir:"action,etag,id,path",remove:"action,etag,id,path"};
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
      if(req.shareOperationAllowed && !req.shareOperationAllowed(["read","mounts","browse"].includes(operation))) {res.set("Retry-After","60");return res.status(429).json({error:"Too many requests"});}
      const fn={previewRemoval:"previewRemoval",removeConfirmed:"removeConfirmed",mounts:"mounts",destination:"destination",rename:"rename",create:"create",grant:"grant",revoke:"grant",browse:"browseOwner",read:"read",write:"mutate",mkdir:"mutate",remove:"mutate"}[operation];
      res.json(await service[fn](req.shareToken,input));
    } catch(error) {
      const [status,message]=messages[error.code] || (error.code==="ENOTEMPTY"?[409,"The folder must be empty before removing it."]:[404,"Shared resource unavailable"]);
      res.status(status).json({error:message,code:messages[error.code]?error.code:"SHARE_UNAVAILABLE"});
    }
  });
  router.get("/api/shares/content",async(req,res)=>{
    try {
      if(Object.keys(req.query).sort().join(",")!=="context,id,path" || typeof req.query.id!=="string" || typeof req.query.path!=="string") return res.status(400).end();
      const file=await service.read(req.shareToken,{id:req.query.id,path:req.query.path});
      if(file.kind!=="file")return res.status(404).end();
      const extension=file.name.split(".").pop().toLowerCase();
      const types={png:"image/png",jpg:"image/jpeg",jpeg:"image/jpeg",gif:"image/gif",webp:"image/webp",avif:"image/avif",mp3:"audio/mpeg",ogg:"audio/ogg",wav:"audio/wav",mp4:"video/mp4",webm:"video/webm"};
      res.set("Content-Security-Policy","sandbox; default-src 'none'; frame-ancestors 'none'");
      res.set("Content-Disposition",types[extension]?"inline":"attachment");
      res.type(types[extension] || "application/octet-stream").send(Buffer.from(file.content,"base64"));
    } catch {res.status(404).end();}
  });
  return router;
}
module.exports={createResourceSharesRouter};
