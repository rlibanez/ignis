import {it, expect} from 'vitest';
import {EventEmitter} from 'node:events';
import {waitForServerStarted} from './server-readiness.mjs';

function child() { const value = new EventEmitter(); value.stdout = new EventEmitter(); return value; }
it('recognizes a chunked event with any field order and ignores unrelated or invalid records', async () => {
  const server = child(), ready = waitForServerStarted(server);
  server.stdout.emit('data', 'Server running on port 9999\n{"event":"server.started","port":0}\n');
  server.stdout.emit('data', '{"port":12345,"message":"new wording","event":"server.');
  server.stdout.emit('data', 'started"}\n');
  await expect(ready).resolves.toBe(12345);
  expect(server.stdout.listenerCount('data')).toBe(0);
  expect(server.listenerCount('exit')).toBe(0);
});
it('reports premature exit or spawn failure without waiting for a timeout', async () => {
  const server = child(), ready = waitForServerStarted(server);
  server.emit('exit', 1);
  await expect(ready).rejects.toThrow('before readiness');
  const missing = child(), failure = waitForServerStarted(missing);
  missing.emit('error', new Error('spawn unavailable'));
  await expect(failure).rejects.toThrow('spawn unavailable');
});
it('bounds waiting and malformed output and releases its listeners', async () => {
  const server = child();
  await expect(waitForServerStarted(server, 5)).rejects.toThrow('timed out');
  expect(server.stdout.listenerCount('data')).toBe(0);
  const noisy = child(), ready = waitForServerStarted(noisy);
  noisy.stdout.emit('data', 'x'.repeat(65537));
  await expect(ready).rejects.toThrow('Oversized');
});
