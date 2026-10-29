// Restore only built-in views with inert, bounded layout data. Never restore
// plugin view state, URLs, commands, arbitrary HTML or hidden configuration paths.
function projectWorkspace(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  let count = 0;
  const ids = new Set();
  const plain = value => value && typeof value === "object" && !Array.isArray(value);
  const filePath = value => typeof value === "string" && value.length <= 1024 &&
    // eslint-disable-next-line no-control-regex
    !/[\\:\x00-\x1f\x7f]/.test(value) && value.split("/").every(part=>part && !part.startsWith(".") && !/[. ]$/.test(part));
  function node(value,depth) {
    if (!plain(value) || depth > 12 || ++count > 128 ||
        typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id) || ids.has(value.id)) return null;
    ids.add(value.id);
    const result = {id:value.id,type:value.type};
    if (["split","tabs"].includes(value.type)) {
      if (!Array.isArray(value.children)) return null;
      result.children = value.children.slice(0,64).map(child=>node(child,depth+1)).filter(Boolean);
      if (value.type === "split") result.direction = value.direction === "vertical" ? "vertical" : "horizontal";
      if (value.type === "tabs" && Number.isInteger(value.currentTab) && value.currentTab >= 0 && value.currentTab < result.children.length) result.currentTab=value.currentTab;
    } else if (value.type === "leaf" && plain(value.state)) {
      const type = value.state.type;
      if (!["empty","markdown","file-explorer","search"].includes(type)) return null;
      result.state = {type,state:{}};
      if (type === "markdown") {
        if (!plain(value.state.state) || !filePath(value.state.state.file)) return null;
        result.state.state.file = value.state.state.file;
        result.state.state.mode = value.state.state.mode === "preview" ? "preview" : "source";
        if (typeof value.state.state.source === "boolean") result.state.state.source=value.state.state.source;
      }
    } else return null;
    if (Number.isFinite(value.dimension) && value.dimension >= 0 && value.dimension <= 100) result.dimension=value.dimension;
    return result;
  }
  const result = {};
  for (const key of ["main","left","right"]) {
    const projected = node(input[key],0);
    if (projected) {
      if (key !== "main") {
        if (typeof input[key].collapsed === "boolean") projected.collapsed=input[key].collapsed;
        if (Number.isFinite(input[key].width) && input[key].width >= 100 && input[key].width <= 2000) projected.width=input[key].width;
      }
      result[key]=projected;
    }
  }
  // Only reference a retained node, not an identifier from discarded plugin state.
  const retained = new Set();
  function collect(value) { if (!value) return; retained.add(value.id); value.children?.forEach(collect); }
  Object.values(result).forEach(collect);
  if (typeof input.active === "string" && retained.has(input.active)) result.active=input.active;
  return result;
}
module.exports = {projectWorkspace};
