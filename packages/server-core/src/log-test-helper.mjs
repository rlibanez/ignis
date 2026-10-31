// Synchronous event capture for tests of callers; logger serialization has its own tests.
import { vi } from 'vitest';
import { createRequire } from 'node:module';
const logger=createRequire(import.meta.url)('./logger');
const groups=new WeakMap();
export function captureLogs(level){
 let group=groups.get(logger.emit);
 if(!group){group=new Map();const spy=vi.spyOn(logger,'emit').mockImplementation((severity,...args)=>group.get(severity)?.(...args));groups.set(spy,group);}
 if(!group.has(level))group.set(level,vi.fn());
 return group.get(level);
}
