import {it,expect} from 'vitest';import {compareLoad} from './compare-load.mjs';
function data(){const row={fileCount:1000,shareCount:10,peakServerRssMiB:100};for(const name of ['tree','bootstrap','catalog','mounts','read','write','postLoadRead','sessionDuringTree'])row[name]={p95Ms:10};return {runs:5,node:'24',fixture:{payload:100},medians:[row]};}
it('enforces the 15 percent budget and reports each measurement',()=>{const before=data(),after=data();after.medians[0].tree.p95Ms=11;expect(compareLoad(before,after).passed).toBe(true);after.medians[0].tree.p95Ms=12;expect(compareLoad(before,after)).toMatchObject({passed:false,budgetPercent:15});});
it('never compares different fixtures, machines or insufficient rounds',()=>{for(const key of ['node','cpuModel','profile','fixture']){const after=data();after[key]='different';expect(()=>compareLoad(data(),after)).toThrow('Incomparable');}const after=data();after.runs=1;expect(()=>compareLoad(data(),after)).toThrow('five');});

it('uses recorded raw samples rather than rounding a millisecond-scale budget decision',()=>{
 const before=data(),after=data();before.medians[0].read.p95Ms=1.2;after.medians[0].read.p95Ms=1.4;
 before.scenarios=Array.from({length:5},()=>({fileCount:1000,shareCount:10,read:{rawMs:[1.249]}}));
 after.scenarios=Array.from({length:5},()=>({fileCount:1000,shareCount:10,read:{rawMs:[1.354]}}));
 expect(compareLoad(before,after).passed).toBe(true);
});
