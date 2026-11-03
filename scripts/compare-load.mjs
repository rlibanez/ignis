import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
export function compareLoad(reference,candidate){
 for(const key of ['fixtureVersion','profile','samples','warmup','cpuModel','arch','platform','node','cpus','cpuMax','memoryMax','kernel','totalMemoryBytes'])if(JSON.stringify(reference[key])!==JSON.stringify(candidate[key]))throw Error('Incomparable measurement: '+key);
 if(reference.runs<5 || candidate.runs<5)throw Error('At least five runs are required');
 if(JSON.stringify(reference.fixture)!==JSON.stringify(candidate.fixture))throw Error('Incomparable fixture');
 const quantile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
 function measurement(data,row,name){
  const samples=data.scenarios?.filter(s=>s.fileCount===row.fileCount && s.shareCount===row.shareCount);
  if(samples?.length && name!=='peakServerRssMiB' && samples.every(s=>Array.isArray(s[name]?.rawMs))){
   if(samples.length!==data.runs)throw Error('Incomplete scenario samples');
   return quantile(samples.map(s=>quantile(s[name].rawMs,.95)),.5);
  }
  return name==='peakServerRssMiB'?row[name]:row[name].p95Ms;
 }
 const comparisons=[];
 for(const before of reference.medians){
  const after=candidate.medians.find(row=>row.fileCount===before.fileCount && row.shareCount===before.shareCount);if(!after)throw Error('Missing scenario');
  for(const name of ['tree','bootstrap','catalog','mounts','read','write','postLoadRead','sessionDuringTree','peakServerRssMiB']){
   const baseline=measurement(reference,before,name);
   const current=measurement(candidate,after,name);
   if(!Number.isFinite(baseline)||baseline<=0||!Number.isFinite(current))throw Error('Invalid metric: '+name);
   const ratio=current/baseline;
   comparisons.push({fileCount:before.fileCount,shareCount:before.shareCount,metric:name,baseline,current,changePercent:+((ratio-1)*100).toFixed(1),passed:ratio<=1.15});
  }
 }
 return {passed:comparisons.every(row=>row.passed),budgetPercent:15,comparisons};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const {values}=parseArgs({options:{reference:{type:'string'},candidate:{type:'string'}}});
 if(!values.reference || !values.candidate)throw Error('Use --reference and --candidate');
 const result=compareLoad(JSON.parse(fs.readFileSync(values.reference)),JSON.parse(fs.readFileSync(values.candidate)));console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
