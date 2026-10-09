import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {parse} from '@babel/parser';
import {extractEmbeddedCode} from '../src/embedded-code.js';
import {unpack} from '../src/unpack.js';

test('extracts eval, Function and string timers through closed native expressions without execution',()=>{
  const text=`globalThis.__embeddedExecuted=true;console['lo'+'g'](3+4);`,encoded=Buffer.from(text).toString('base64');
  const source=`eval(atob('${encoded}'));new Function('x','return x^7;');setTimeout('console.log(9);',100);`;
  const result=extractEmbeddedCode(source);assert.equal(result.payloads.length,3);
  assert.equal(result.payloads[0].raw,text);assert.match(result.payloads[1].code,/function extractedFunction\(x\)/);
  assert.equal(globalThis.__embeddedExecuted,undefined);
  const out=unpack(source);assert.equal(out.embedded.payloads.length,3);assert.match(out.embedded.payloads[0].readable,/console\.log\(7\)/);
  assert.match(out.code,/eval\(/);assert.equal(globalThis.__embeddedExecuted,undefined);
});
test('deduplicates payloads, reports malformed strings and respects extraction/recursion budgets',()=>{
  const source=`eval('console.log(7);');setTimeout('console.log(7);',1);eval('const = bad');eval(dynamic);`;
  const result=extractEmbeddedCode(source);assert.equal(result.payloads.length,2);assert.equal(result.payloads[0].sites.length,2);
  assert.ok(result.payloads[1].syntaxError);assert.equal(result.unresolved.length,1);
  assert.equal(extractEmbeddedCode(source,{maxPayloads:1}).payloads.length,1);
  assert.equal(extractEmbeddedCode(source,{maxPayloads:1}).payloads[0].sites.length,2);
  assert.equal(extractEmbeddedCode(source,{maxBytes:1}).payloads.length,0);
  assert.equal(extractEmbeddedCode(`new Function('a'.repeat(100),'return 7;');`,{maxBytes:64}).payloads.length,0);
  const nested=unpack(`eval(${JSON.stringify(`eval(${JSON.stringify('console.log(3+4);')});`)});`);
  assert.equal(nested.embedded.payloads[0].nested.payloads.length,1);
  assert.match(nested.embedded.payloads[0].nested.payloads[0].readable,/console\.log\(7\)/);
});
test('does not infer mutated natives, shadowed code constructors or dynamically mutable bindings',()=>{
  const source=`atob=()=> 'changed';eval(atob('Y29uc29sZS5sb2coNyk7'));function Function(x){return x;}Function('console.log(9);');`;
  const result=extractEmbeddedCode(source);assert.equal(result.payloads.length,0);assert.equal(result.stats.candidates,1);
  assert.equal(extractEmbeddedCode(`var code='console.log(7);';eval('code="changed"');eval(code);`).payloads.length,1);
  assert.equal(extractEmbeddedCode(`const code='console.log(7);';eval(code);`).payloads.length,1);
});
test('CLI saves payloads and an inert reader view while preserving the submitted input',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pelican-embedded-test-'));
  try{
    const input=path.join(root,'input.js'),output=path.join(root,'out'),payload=`const text='</script><script>globalThis.attack=true</script>';console.log(3+4);`;
    const source=`eval(${JSON.stringify(payload)});`;await fs.writeFile(input,source);
    const child=spawn(process.execPath,['unpack.js',input,output],{cwd:path.resolve('.'),windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Embedded CLI timeout'));},30000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve(code);});});
    assert.equal(code,0,stderr);
    const manifest=JSON.parse(await fs.readFile(path.join(output,'reports/EMBEDDED_CODE.json'),'utf8'));assert.equal(manifest.payloads.length,1);
    const readable=await fs.readFile(path.join(output,manifest.payloads[0].file),'utf8');parse(readable);assert.match(readable,/console\.log\(7\)/);
    assert.equal(await fs.readFile(input,'utf8'),source);
    const html=await fs.readFile(path.join(output,'reader.html'),'utf8');assert.doesNotMatch(html,/<script>globalThis\.attack/);
    const model=JSON.parse(html.match(/id="model">([\s\S]*?)<\/script>/)[1]);assert.equal(model.embeddedCode.payloads.length,1);
  }finally{const absolute=path.resolve(root);if(path.dirname(absolute)===path.resolve(os.tmpdir())&&path.basename(absolute).startsWith('pelican-embedded-test-'))await fs.rm(absolute,{recursive:true,force:true});}
});
