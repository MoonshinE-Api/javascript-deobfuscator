import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {runBoundedNode,MAX_HEAP_MB} from './bounded-node.js';
const worker=fileURLToPath(new URL('./standalone-worker.js',import.meta.url));
export function standaloneConcurrency(heapMb=512){return Math.max(1,Math.min(Math.floor((os.availableParallelism?.()??os.cpus().length)*0.8),4,Math.floor(os.freemem()*0.55/(heapMb*1024*1024*1.6))));}
export async function standaloneTasks(tasks,{maxCPU=false,onProgress=()=>{}}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pelican-standalone-')),results=new Array(tasks.length),resources=new Array(tasks.length),workers=Math.min(tasks.length,maxCPU?standaloneConcurrency(MAX_HEAP_MB):1);let cursor=0;
 try{
  const settled=await Promise.allSettled(Array.from({length:workers},async()=>{while(cursor<tasks.length){
   const i=cursor++,task=tasks[i],directory=path.join(root,String(i));await fs.mkdir(directory);const file=path.join(directory,'job.json');await fs.writeFile(file,JSON.stringify({type:task.type,data:task.data,output:directory}));
   const inputBytes=Math.max(...Object.values(task.data).filter(value=>typeof value==='string').map(value=>Buffer.byteLength(value)),0);
   onProgress(task.type);const options={args:[file],heapMb:inputBytes>=1024*1024?MAX_HEAP_MB:512,timeoutMs:inputBytes>=512*1024?600000:['core','measure'].includes(task.type)?180000:60000,onDiagnostic:chunk=>{for(const line of chunk.split('\n'))if(line.startsWith('[deobf]'))onProgress(line.slice(8).trim());}};
   let processResult=await runBoundedNode(worker,options);
   if(processResult.memory&&options.heapMb<MAX_HEAP_MB){onProgress(task.type+' exceeded '+options.heapMb+' MiB; retrying with '+MAX_HEAP_MB+' MiB');options.heapMb=MAX_HEAP_MB;processResult=await runBoundedNode(worker,options);}
   resources[i]={task:task.type,heapMb:options.heapMb,timeoutMs:options.timeoutMs};
   if(!processResult.ok)throw new Error(task.type+': '+processResult.error);
   const output=path.join(directory,'result.json');if((await fs.stat(output)).size>64*1024*1024)throw new Error('Standalone analysis result exceeds 64 MiB');results[i]=JSON.parse(await fs.readFile(output,'utf8'));if(results[i].error)throw new Error(task.type+': '+results[i].error);
  }}));const failed=settled.find(r=>r.status==='rejected');if(failed)throw failed.reason;return {results,workers,resources};
 }finally{const absolute=path.resolve(root);if(path.dirname(absolute)===path.resolve(os.tmpdir())&&path.basename(absolute).startsWith('pelican-standalone-'))await fs.rm(absolute,{recursive:true,force:true}).catch(()=>{});}
}
