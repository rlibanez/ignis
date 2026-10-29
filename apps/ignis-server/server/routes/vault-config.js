const router = require("express").Router();
function handle(req, res, operation, input) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (!req.vaultConfiguration) return res.status(503).json({error:"Configuration unavailable"});
    return res.json(req.vaultConfiguration(operation, input || {}));
  } catch (error) {
    const code = error.code;
    if (code === "PREFERENCES_CONFLICT")
      return res.status(409).json({error:"Settings changed in another tab. Reload before saving again.",code});
    if (["INVALID_VAULT_SELECTION", "INVALID_CONFIGURATION", "UNSUPPORTED_CONFIGURATION", "INVALID_PREFERENCES"].includes(code))
      return res.status(400).json({error:"Invalid configuration request"});
    if (code === "PREFERENCES_QUOTA") return res.status(413).json({error:"Configuration storage limit reached"});
    if (code === "PREFERENCES_UNAVAILABLE") return res.status(404).json({error:"Configuration unavailable"});
    return res.status(503).json({error:"Configuration unavailable"});
  }
}
router.get("/", (req, res) => handle(req, res, "read", req.query));
router.post("/", (req, res) => handle(req, res, "write", req.body));
module.exports = router;
