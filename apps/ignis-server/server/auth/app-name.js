// Presentation only. Never use this name as an identifier or filesystem path.
function readAppName(env = process.env) {
  const value = env.IGNIS_APP_NAME;
  if (value !== undefined && typeof value !== 'string') throw new Error('Invalid IGNIS_APP_NAME');
  const name = value?.trim() || 'Ignis';
  if ([...name].length > 80 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value || ''))
    throw new Error('Invalid IGNIS_APP_NAME; use at most 80 printable characters');
  return name;
}
function brandedAssets(assets, appName = 'Ignis') {
  const result = new Map(assets);
  const manifest = assets.get('/manifest.webmanifest');
  result.set('/manifest.webmanifest', {...manifest, content: JSON.stringify({
    ...JSON.parse(manifest.content.toString()), name: appName, short_name: appName,
  })});
  const runtime = assets.get('/auth/i18n.js');
  // JSON serialization, never string interpolation into executable syntax.
  const encoded = JSON.stringify(appName).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  result.set('/auth/i18n.js', {...runtime, content: 'globalThis.__ignisAppName = ' + encoded + ';\n' + runtime.content.toString()});
  return result;
}
module.exports = {readAppName, brandedAssets};
