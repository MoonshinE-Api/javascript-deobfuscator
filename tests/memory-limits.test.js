import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runBoundedNode,MAX_HEAP_MB} from '../src/bounded-node.js';
test('bounded workers accept 2 GiB and actually receive the V8 heap flag',async()=>{
  assert.equal(MAX_HEAP_MB,2048);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pelican-2gb-test-'));
  try{
    const file=path.join(root,'check.mjs');await fs.writeFile(file,`import v8 from 'node:v8';if(!process.execArgv.includes('--max-old-space-size=2048')||v8.getHeapStatistics().heap_size_limit<2048*1024*1024)process.exitCode=1;`);
    assert.equal((await runBoundedNode(file,{heapMb:2048,timeoutMs:10000})).ok,true);
    assert.throws(()=>runBoundedNode(file,{heapMb:2049}),/Invalid analysis process limits/);
  }finally{const resolved=path.resolve(root);if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('pelican-2gb-test-'))await fs.rm(resolved,{recursive:true,force:true});}
});
