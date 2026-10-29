import { createPrivateConfiguration } from "./private-configuration.js";
import { createPrivateFiles } from "./private-files.js";

// One gateway is passed to every FS factory before boot. Activation is one-shot.
export function createPrivateRuntime(currentContext, makeConfiguration = createPrivateConfiguration, onWriteFailure) {
  let adapter = null;
  let configured = false;
  let blocked = false;
  const inactive = {
    select:()=>null, assertOrdinary:()=>{}, allowsSharedPrefetch:()=>true,
    rootEntries:entries=>entries, rootEntriesAsync:async entries=>entries,
  };
  const gateway = new Proxy(Object.freeze({}), {
    get(_target,name) {
      if (blocked) throw new Error("Private configuration initialization failed");
      if (adapter) return adapter[name];
      if (Object.hasOwn(inactive,name)) return inactive[name];
      return undefined;
    },
  });
  function configure(bootstrap) {
    if (configured) throw new Error("File configuration already initialized");
    configured = true;
    const mode = bootstrap.configurationMode;
    if (mode === undefined || mode === "shared") return bootstrap.tree;
    blocked = true;
    if (mode !== "private") throw new Error("Unsupported file configuration mode");
    const context = currentContext();
    if (!context?.sessionId || !context.vault || context.vault !== bootstrap.vault?.uuid)
      throw new Error("Private configuration context unavailable");
    const candidate = createPrivateFiles(makeConfiguration({...context,currentContext,...(onWriteFailure ? {onWriteFailure} : {})}));
    const tree = candidate.projectTree(bootstrap.tree,bootstrap.privateConfiguration);
    adapter = candidate;
    blocked = false;
    return tree;
  }
  return Object.freeze({gateway,configure});
}
