import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parse} from '@babel/parser';
import {standaloneTasks,standaloneConcurrency} from '../src/standalone-tasks.js';

const project=fileURLToPath(new URL('../',import.meta.url));
function command(args){return new Promise(resolve=>{const processChild=spawn(process.execPath,args,{cwd:project,windowsHide:true,env:{...process.env,NODE_OPTIONS:''}});let stdout='',stderr='';processChild.stdout.on('data',x=>stdout+=x);processChild.stderr.on('data',x=>stderr+=x);processChild.on('close',code=>resolve({code,stdout,stderr}));});}
test('standalone max CPU CLI produces complete code, a friendly guide and reduction metadata',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pelican-cli-test-'));
 try{
  const input=path.join(root,'input.js'),output=path.join(root,'result');
  const code='globalThis.answer=(function(){'+Array.from({length:1000},(_,i)=>`var unused${i}={a:1};`).join('\n')+'fetch("https://example.invalid");return 42;})();';await fs.writeFile(input,code);
  const result=await command(['unpack.js',input,output,'--max-cpu']);assert.equal(result.code,0,result.stderr);
  const report=JSON.parse(await fs.readFile(path.join(output,'reports/report.json'),'utf8'));
  assert.equal(report.performance.maxCPU,true);assert.ok(report.performance.analysisWorkers>=1&&report.performance.analysisWorkers<=4);assert.equal(report.performance.heapMbPerWorker,512);assert.equal(report.performance.maximumHeapMb,2048);
  assert.ok(report.reduction.fullLines<25);assert.ok(report.reduction.removedBindings>=1000);assert.equal(report.shortReading.operations,1);
  const full=await fs.readFile(path.join(output,'src/full-human-readable.js'),'utf8'),guide=await fs.readFile(path.join(output,'src/short-human-readable.js'),'utf8');parse(full);parse(guide,{sourceType:'module'});
  const html=await fs.readFile(path.join(output,'reader.html'),'utf8');const model=JSON.parse(html.match(/id="model">([\s\S]*?)<\/script>/)[1]);
  assert.equal(model.shortReading.sites.length,1);assert.match(model.shortReading.sites[0].action,/server/);const site=model.shortReading.sites[0];assert.ok(full.split('\n')[site.line-1].includes('fetch('));
  assert.equal(await fs.readFile(input,'utf8'),code);assert.match(result.stdout,/short guide:/);
 }finally{const absolute=path.resolve(root);if(path.dirname(absolute)===path.resolve(os.tmpdir())&&path.basename(absolute).startsWith('pelican-cli-test-'))await fs.rm(absolute,{recursive:true,force:true});}
});
test('standalone help documents the flag and invalid jobs fail without stranding sibling analyses',async()=>{
 const help=await command(['unpack.js','--help']);assert.equal(help.code,0);assert.match(help.stdout,/--max-cpu/);assert.match(help.stdout,/RAM-aware/);
 await assert.rejects(standaloneTasks([{type:'invalid',data:{}},{type:'reading',data:{application:'function test(){return 1;}',modules:[]}}],{maxCPU:true}),/Unknown standalone task/);
 assert.ok(Number.isInteger(standaloneConcurrency()));assert.ok(standaloneConcurrency()>=1&&standaloneConcurrency()<=4);
});
test('installed deobfuscator CLI uses the complete readable pipeline',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pelican-cli-quality-'));
 try{
  const input=path.join(root,'input.js'),output=path.join(root,'output.js');
  await fs.writeFile(input,`globalThis.result=(function(){function _0xabc(s){return atob(s);}return _0xabc('aGVsbG8=');})();`);
  const result=await command(['src/deobfuscate.js',input,'-o',output]);assert.equal(result.code,0,result.stderr);
  const text=await fs.readFile(output,'utf8');assert.match(text,/return "hello"/);assert.doesNotMatch(text,/atob\(|_0xabc/);parse(text);
 }finally{const absolute=path.resolve(root);if(path.dirname(absolute)===path.resolve(os.tmpdir())&&path.basename(absolute).startsWith('pelican-cli-quality-'))await fs.rm(absolute,{recursive:true,force:true});}
});
