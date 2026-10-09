import {spawn} from 'node:child_process';
export const MAX_HEAP_MB = 2048;

// This is a process boundary, rather than a try/catch around a V8 allocation.
// A fatal heap error belongs to the child; the parent can report the failure.
export function runBoundedNode(modulePath,{args=[],heapMb=384,timeoutMs=15000,onDiagnostic}={}){
 if(!Number.isInteger(heapMb)||heapMb<32||heapMb>MAX_HEAP_MB||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('Invalid analysis process limits');
 return new Promise(resolve=>{
   const child=spawn(process.execPath,['--max-old-space-size='+heapMb,'--expose-gc',modulePath,...args],{stdio:['ignore','ignore','pipe'],windowsHide:true,env:{...process.env,NODE_OPTIONS:''}});
   let diagnostic='',timedOut=false,spawnError=null;
   child.stderr.on('data',bytes=>{diagnostic=(diagnostic+bytes.toString()).slice(-8192);onDiagnostic?.(bytes.toString());});
   const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
   child.on('error',error=>{spawnError=error.message;});
   child.on('close',(code,signal)=>{clearTimeout(timer);const memory=/heap out of memory|allocation failed|Reached heap limit/i.test(diagnostic);
     resolve({ok:code===0&&!timedOut&&!spawnError,code,signal,timedOut,memory,
       error:timedOut?'Script analysis exceeded '+timeoutMs+' ms; original source retained.':memory?'Script analysis exceeded its '+heapMb+' MiB V8 heap; original source retained.':spawnError?'Analysis process could not start: '+spawnError:code!==0?'Script analysis process exited unsuccessfully; original source retained.':null});
   });
 });
}
