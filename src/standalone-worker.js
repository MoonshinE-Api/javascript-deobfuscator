import fs from 'node:fs/promises';
import path from 'node:path';
// Submitted code is parsed statically; this worker never executes it.
const job=JSON.parse(await fs.readFile(process.argv[2],'utf8'));let result;
try{
 if(job.type==='core'){
  const {unpack}=await import('./unpack.js'),{fullReadable}=await import('./full-readable.js');result=unpack(job.data.source,{deep:true,onStage:name=>console.error('[deobf] '+name)});globalThis.gc?.();result.full=fullReadable(result.code);
 }else if(job.type==='measure'){
  const {unpack}=await import('./unpack.js'),{fullReadable}=await import('./full-readable.js'),{parse}=await import('@babel/parser'),g=await import('@babel/generator');
  const resultCore=unpack(job.data.source,{deep:true});globalThis.gc?.();const full=fullReadable(resultCore.code);
  result={name:job.data.name,originalLines:(g.default.default??g.default)(parse(job.data.source,{sourceType:'unambiguous'})).code.split('\n').length,readableLines:resultCore.code.trimEnd().split('\n').length,fullLines:full.stats.outputLines,shrink:resultCore.stats.shrink};
 }else if(job.type==='reading'){
  const {buildReadingModel}=await import('./reader.js'),{buildBehavior}=await import('./behavior.js'),{addBrief}=await import('./reading-brief.js');
  result=buildReadingModel(job.data.application,job.data.modules);result.behavior=buildBehavior(job.data.application,result);addBrief(result);
 }else if(job.type==='fingerprints'){
  const {buildFingerprints}=await import('./fingerprints.js');result=buildFingerprints(job.data.code,null,{input:job.data.source});
 }else throw new Error('Unknown standalone task');
}catch(error){result={error:String(error.message).slice(0,1000)};}
await fs.writeFile(path.join(job.output,'result.json'),JSON.stringify(result));
