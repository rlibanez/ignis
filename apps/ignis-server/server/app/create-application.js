// Single-use application lifecycle. Process signals and exit policy belong to index.js.
function createApplication({createRuntime = () => require('./compose-server').composeServer()} = {}) {
  let state = 'idle', runtime, starting, stopping, closing;
  const close = () => closing ||= Promise.resolve().then(() => runtime?.close());
  function start() {
    if (stopping) return Promise.reject(new Error('Application is stopped'));
    return starting ||= Promise.resolve().then(async () => {
      state = 'starting';
      runtime = await createRuntime();
      const address = await runtime.start();
      state = 'running';
      return address;
    }).catch(async error => {
      state = 'failed';
      try { await close(); }
      catch (cleanup) { throw new AggregateError([error,cleanup],'Application startup and cleanup failed'); }
      throw error;
    });
  }
  function stop() {
    return stopping ||= Promise.resolve().then(async () => {
      if (starting) await starting.catch(() => {});
      state = 'stopping';
      try { await close(); }
      finally { state = 'stopped'; }
    });
  }
  return Object.freeze({start,stop,get state() {return state;}});
}
module.exports = {createApplication};
