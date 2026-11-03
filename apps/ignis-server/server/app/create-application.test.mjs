import {it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
const {createApplication}=createRequire(import.meta.url)('./create-application');
const {disposeAll}=createRequire(import.meta.url)('./dispose');

it('constructs lazily, starts once and closes once under concurrent calls',async()=>{
  const runtime={start:vi.fn(async()=>({port:1234})),close:vi.fn(async()=>{})};
  const createRuntime=vi.fn(()=>runtime),application=createApplication({createRuntime});
  expect(createRuntime).not.toHaveBeenCalled();
  const first=application.start();
  expect(application.start()).toBe(first);
  await expect(first).resolves.toEqual({port:1234});
  expect(application.state).toBe('running');
  const stopped=application.stop();expect(application.stop()).toBe(stopped);await stopped;
  expect(runtime.close).toHaveBeenCalledTimes(1);
  expect(runtime.start).toHaveBeenCalledTimes(1);
  expect(application.state).toBe('stopped');
  await expect(application.start()).rejects.toThrow('stopped');
});
it('waits for startup before closing when stop arrives during initialization',async()=>{
  let release;const ready=new Promise(resolve=>release=resolve),calls=[];
  const application=createApplication({createRuntime:()=>({start:()=>ready,close:async()=>calls.push('closed')})});
  const start=application.start(),stop=application.stop();
  await Promise.resolve();expect(calls).toEqual([]);
  release({port:1});await start;await stop;expect(calls).toEqual(['closed']);
});
it('cleans a partially started runtime after a bind failure and preserves both errors',async()=>{
  const close=vi.fn(async()=>{throw new Error('cleanup failure');});
  const application=createApplication({createRuntime:()=>({start:async()=>{throw new Error('port occupied');},close})});
  const error=await application.start().catch(error=>error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors.map(error=>error.message)).toEqual(['port occupied','cleanup failure']);
  await expect(application.stop()).rejects.toThrow('cleanup failure');
  expect(close).toHaveBeenCalledTimes(1);
});
it('stop before start acquires nothing and disposal continues after a failed resource',async()=>{
  const createRuntime=vi.fn(),application=createApplication({createRuntime});
  await application.stop();await expect(application.start()).rejects.toThrow();
  expect(createRuntime).not.toHaveBeenCalled();
  const calls=[],disposers=[()=>calls.push('db'),()=>{calls.push('plugin');throw new Error('failure');},()=>calls.push('listeners')];
  await expect(disposeAll(disposers)).rejects.toThrow('cleanup failed');
  expect(calls).toEqual(['listeners','plugin','db']);expect(disposers).toEqual([]);
});
