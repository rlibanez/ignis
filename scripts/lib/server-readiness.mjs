// Consume the structured readiness event, independently of human-readable messages.
export function waitForServerStarted(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let pending = '';
    const finish = (error, port) => {
      clearTimeout(timer);
      child.stdout.off('data', data);
      child.off('error', failed);
      child.off('exit', exited);
      if (error) reject(error); else resolve(port);
    };
    const failed = error => finish(error);
    const exited = (code, signal) => finish(new Error(`Server exited before readiness (${signal || code})`));
    const data = chunk => {
      pending += chunk.toString();
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.event === 'server.started' && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535) {
          finish(null, record.port);
          return;
        }
      }
      if (pending.length > 65536) finish(new Error('Oversized server readiness record'));
    };
    const timer = setTimeout(() => finish(new Error('Server startup timed out')), timeoutMs);
    child.stdout.on('data', data);
    child.once('error', failed);
    child.once('exit', exited);
  });
}
