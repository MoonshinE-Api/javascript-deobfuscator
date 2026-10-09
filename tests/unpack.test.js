import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { unpack } from '../src/unpack.js';

test('full pipeline retains globals observed through indirect eval, native properties and generated functions',()=>{
 for(const source of [
  `var x=3;var f=eval;f('x=4');globalThis.result=x;`,
  `var x=3;Object.defineProperty(globalThis,'x',{value:9,writable:true});globalThis.result=x;`,
  `var x=3;globalThis.result=Function('return x')();`,
  `var x=3;globalThis.result=globalThis['x'];`
 ]){
  const out=unpack(source,{deep:true}),before={},after={};
  vm.runInNewContext(source,before,{timeout:1000});vm.runInNewContext(out.code,after,{timeout:1000});
  assert.equal(after.result,before.result);assert.match(out.code,/var x = 3/);
 }
});

test('function and class names survive direct, alias and descriptor inspection',()=>{
 for(const source of [
  `function run(){function a(e){return typeof e==='function';}return [a.name,a(()=>{})];}globalThis.result=run();`,
  `function run(){const a=e=>e+1;const alias=a;return [alias.name,alias(3)];}globalThis.result=run();`,
  `function run(){function a(e){return typeof e==='function';}return Object.getOwnPropertyDescriptor(a,'name').value;}globalThis.result=run();`,
  `function run(){class a{read(){return 3;}}return [a.name,new a().read()];}globalThis.result=run();`
 ]){
  const out=unpack(source,{deep:true}),before={},after={};
  vm.runInNewContext(source,before,{timeout:1000});vm.runInNewContext(out.code,after,{timeout:1000});
  assert.equal(JSON.stringify(after.result),JSON.stringify(before.result));
 }
});

test('unpacks a controlled Webpack fixture and preserves its result', () => {
  const source = `var result; (function(){
    var e={1:function(e,t,n){n.d(t,{A:function(){return a}});var a="ready";},
      2:function(e,t,n){var r=n(1);t.text=r.A;},
      3:function(e){e.exports=4;}},t={};
    function n(r){if(t[r])return t[r].exports;var o=t[r]={exports:{}};return e[r](o,o.exports,n),o.exports;}
    n.d=function(e,t){for(var r in t)Object.defineProperty(e,r,{get:t[r]});};
    var r=n(2);result=(r.text,n(3)+r.text);
  })();`;
  const output = unpack(source);
  const before = {}, after = {};
  // Execute only this trusted fixture, never the submitted input.
  vm.runInNewContext(source, before, { timeout: 1000 });
  vm.runInNewContext(output.code, after, { timeout: 1000 });
  assert.equal(after.result, before.result);
  assert.equal(output.modules.length, 3);
  assert.equal(output.modules[0].literalExports.A, 'ready');
  assert.ok(output.stats.annotations > 0);
  assert.ok(output.stats.expandedSequences > 0);
  for (const module of output.modules) parse(module.code, { sourceType: 'module' });
});
test('general scripts use the full pipeline without a Webpack layout', () => {
  const output = unpack('var x="a|b".split("|"); console.log(x);');
  assert.equal(output.stats.format, 'general JavaScript');
  assert.equal(output.modules.length, 0);
  assert.ok(output.stats.advanced.literalCalls > 0);
  parse(output.code, { sourceType: 'unambiguous' });
});

test('supports array factories and variable-bound loaders without changing trusted fixture results', () => {
  const source=`var result;(function(){var modules=[function(m){m.exports=3;},function(m){m.exports=4;}],cache={};
    var load=function(id){if(cache[id])return cache[id].exports;var m=cache[id]={exports:{}};modules[id](m,m.exports,load);return m.exports;};
    result=load(0)+load(1);})();`;
  const out=unpack(source);const before={},after={};vm.runInNewContext(source,before);vm.runInNewContext(out.code,after);
  assert.equal(after.result,before.result);assert.equal(out.stats.format,'Webpack');assert.equal(out.modules.length,2);
});
test('supports numeric string module IDs and preserves unsupported loader wrappers', () => {
  const source=`var result;(function(){var modules={'1':function(m){m.exports=3;},'2':function(m){m.exports=4;}},cache={};
    function load(id){if(cache[id])return cache[id].exports;var m=cache[id]={exports:{}};modules[id](m,m.exports,load);return m.exports;}result=load(1)+load(2);})();`;
  const out=unpack(source);assert.equal(out.modules.length,2);
  const fallback=unpack(`var table={1:function(){return 3;},2:function(){return 4;}};var result=table[1]();`);
  assert.equal(fallback.stats.format,'general JavaScript');assert.equal(fallback.modules.length,0);
  const after={};vm.runInNewContext(fallback.code,after);assert.equal(after.result,3);
});
