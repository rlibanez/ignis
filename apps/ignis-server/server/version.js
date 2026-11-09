const fs = require('node:fs');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const defaultRoot = path.resolve(__dirname, '../../..');
function createBuildInfo({root = defaultRoot, env = process.env, build} = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || !/^\d+\.\d+\.\d+$/.test(pkg.ignis?.upstream?.version || '')) throw Error('Invalid product or upstream version');
  if (env.IGNIS_VERSION && env.IGNIS_VERSION !== pkg.version) {
    throw Error("IGNIS_VERSION must match package.json version " + pkg.version);
  }
  const stamp = build || env.IGNIS_BUILD || `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
  if (!/^[a-z0-9._-]{1,80}$/i.test(stamp)) throw Error('Invalid IGNIS_BUILD');
  return {schema:1,semver:pkg.version,build:stamp,
    version:pkg.version,upstream:{...pkg.ignis.upstream}};
}

let cached;
function getInfo() {
  if (cached) return cached;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname,'build-info.json'),'utf8'));
    if (data.schema === 1 && data.semver && data.version && data.build && data.upstream) {
      const {schema,semver,build} = data;
      const {version,repository} = data.upstream;
      return cached = {schema,semver,build,upstream:{version,repository},version:semver};
    }
  } catch { /* Source checkouts can run without a bundle. */ }
  return cached = createBuildInfo({build:'dev'});
}
// Plugin manifests retain canonical SemVer; assets keep a unique per-build stamp.
const getVersion = () => `${getInfo().semver}+${getInfo().build}`;
const getSemver = () => getInfo().semver;
const getBuild = () => getInfo().build;
module.exports = {createBuildInfo,getInfo,getVersion,getSemver,getBuild};
