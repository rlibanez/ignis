const express = require("express");
const { getInfo } = require("../version");
const config = require("../config");

const router = express.Router();

// Clients display the release version.
router.get("/", (req, res) => {
  const {schema,semver,build,upstream} = getInfo();
  res.set("Cache-Control", "no-store").json({
    schema, semver, build, upstream, version: semver,
    obsidianVersion: config.obsidianVersion,
  });
});

module.exports = router;
