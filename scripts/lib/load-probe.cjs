// Opt-in benchmark instrumentation, loaded only by check-load via --require.
const {monitorEventLoopDelay,performance}=require('node:perf_hooks');
const fs=require('node:fs');
const histogram=monitorEventLoopDelay({resolution:10}),started=performance.eventLoopUtilization();
histogram.enable();
process.once('exit',()=>{
 histogram.disable();
 fs.writeFileSync(process.env.IGNIS_LOAD_PROBE_OUTPUT,JSON.stringify({resolutionMs:10,samples:histogram.count,p50Ms:histogram.percentile(50)/1e6,p95Ms:histogram.percentile(95)/1e6,maxMs:histogram.max/1e6,utilization:performance.eventLoopUtilization(started).utilization}),{mode:0o600});
});
