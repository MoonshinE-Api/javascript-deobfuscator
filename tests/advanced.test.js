import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {advanced,diagnostics} from '../src/advanced.js';
const generate=generatorModule.default??generatorModule;
function run(source){const ast=parse(source);const stats=advanced(ast);const code=generate(ast).code;parse(code);return {code,stats};}
function result(source){const context={atob:globalThis.atob};vm.runInNewContext(source,context,{timeout:1000});return JSON.stringify(context.result);}

test('nested initialized proxy helpers simplify while early calls and escapes retain TDZ behavior',()=>{
  const samples=[
    `function run(){const ops={sum:function(a,b){return a+b;},value:7};function second(){return first();}function first(){return ops.sum(2,3)+ops.value;}return second();}var result=run();`,
    `function run(){const ops={call:function(fn,value){return (0,fn)(value);}};return (()=>ops.call(x=>x+1,4))();}var result=run();`,
    `function run(){const ops={value:7};function first(n){return n?second(n-1):ops.value;}function second(n){return first(n);}return first(3);}var result=run();`,
    `function run(){let result;try{result=early();}catch(error){result=error.name;}const ops={value:7};function early(){return ops.value;}return result;}var result=run();`,
    `function run(){let saved=early;let result;try{result=saved();}catch(error){result=error.name;}const ops={value:7};function early(){return ops.value;}return result;}var result=run();`,
    `function run(){return early;const ops={value:7};function early(){return ops.value;}}var result;try{result=run()();}catch(error){result=error.name;}`
  ];
  for(const source of samples){const out=run(source);assert.equal(result(out.code),result(source));}
  assert.ok(run(samples[0]).stats.proxyCalls>0);assert.equal(run(samples[3]).stats.proxyReads,0);
});

test('constant branches preserve selected block functions in sloppy and strict code',()=>{
  for(const strict of ['',`'use strict';`])for(const condition of ['true','false']){
    const source=`${strict}function run(){if(${condition}){var unused=1;}else{function local(){return 8;}return local();}return typeof local;}var result=run();`;
    const out=run(source);assert.equal(result(out.code),result(source));
  }
});

test('decodes literal encodings and string/array method chains without input execution',()=>{
  const source=`var result=[atob('aGVsbG8='),String.fromCharCode(65,66),decodeURIComponent('%E2%9C%93'), 'c|b|a'.split('|').reverse().join('')];`;
  const out=run(source);assert.equal(result(out.code),result(source));assert.ok(out.stats.literalCalls>=6);assert.ok(!out.code.includes('atob('));
});
test('preserves conditional initialization, TDZ reads, special numbers and builtin mutations',()=>{
  const sources=[`var flag=false;if(flag)var x=7;var result=[x];`, `var x=-0;var result=[Object.is(x,-0)];`,
    `function f(atob){return atob('aGVsbG8=');}var result=f(x=>'custom');`,
    `String.prototype.trim=function(){return 'custom';};var result='a'.trim();`];
  for(const source of sources){const out=run(source);assert.equal(result(out.code),result(source));}
  assert.throws(()=>vm.runInNewContext(run(`var result=x;let x=3;`).code),{name:'ReferenceError'});
});
test('inlines immutable proxy operations with argument order and unbound call receivers intact',()=>{
  const source=`var log=[];function side(n){log.push(n);return n;}
    var p={add:function(a,b){return a+b;},call:function(f,x){return f(x);},text:'done'};
    var obj={value:100,f:function(x){'use strict';return [this===undefined,x];}};
    var result=[p.add(side(1),side(2)),p.call(obj.f,side(3)),p.text,log];`;
  const out=run(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.proxyCalls,2);assert.equal(out.stats.proxyReads,1);
});
test('leaves escaping, mutable, duplicate-parameter and effect-dropping proxy functions intact',()=>{
  const sources=[`var p={add:function(a,b){return a+b;}};p.add=function(){return 9;};var result=p.add(1,2);`,
    `var p={add:function(a,b){return a+b;}};function mutate(o){o.add=()=>9;}mutate(p);var result=p.add(1,2);`,
    `var log=[];var p={f:function(a,a){return a+a;}};var result=[p.f(log.push(1),2),log];`,
    `var log=[];var p={f:function(a,b){return a&&b;}};var result=[p.f(false,log.push(1)),log];`];
  for(const source of sources){const out=run(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.proxyCalls,0);}
});
test('unflattens ordered dispatchers while retaining final counter reads and hoisted variables',()=>{
  const source=`var order='2|0|1'.split('|'),index=0,log=[];
    while(true){switch(order[index++]){case '0':log.push('middle');continue;case '1':log.push('last');continue;case '2':log.push('first');continue;case 'unused':var hidden=9;continue;}break;}
    var result=[log,index,hidden];`;
  const out=run(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.dispatchers,1);assert.ok(!out.code.includes('switch ('));
});
test('dispatcher return paths increment only the stages that actually run',()=>{
  const source=`var index;function f(flag){var order=['0','1'],i=0;index=()=>i;while(true){switch(order[i++]){case '0':if(flag)return 7;continue;case '1':return 9;}break;}}var result=[f(true),index(),f(false),index()];`;
  const out=run(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.dispatchers,1);
});
test('retains unsupported dispatcher semantics and compiler async state machines',()=>{
  for(const source of [`var o=['0'],i=0;while(true){switch(o[i++]){case '0':let x=1;continue;}break;}`,
    `var o=['0','1'],i=0;while(true){switch(o[i++]){case '0':i++;continue;case '1':continue;}break;}`,
    `function f(c){switch(c.prev=c.next){case 0:c.next=2;return c.stop();}}`])assert.equal(run(source).stats.dispatchers,0);
  assert.equal(diagnostics(parse(`function f(c){switch(c.prev=c.next){case 0:return c.stop();}}`)).asyncStateMachines,1);
});
test('constant dead branches keep var hoisting and skip dynamic scopes',()=>{
  const source=`if(false){var x=9;throw Error('not reached');}else{var y=2;}var result=[x,y];`;
  const out=run(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.deadBranches,1);
  assert.ok(run(`var x=3;eval('x=4');var result=x;`).stats.skipped);
});

test('retains program bindings when global property writes or generated functions can change them',()=>{
  for(const source of [`var x=3;globalThis.x=4;var result=x;`, `var x=3;Function('x=4')();var result=x;`,
    `var p={value:3};globalThis.p.value=4;var result=p.value;`]){
    const out=run(source);assert.equal(result(out.code),result(source));
  }
});

test('keeps indirect eval, global descriptor writes and native aliases from invalidating substitutions',()=>{
  const sources=[`var x=3;var f=eval;f('x=4');var result=x;`,
    `var x=3;Object.defineProperty(globalThis,'x',{value:4,writable:true});var result=x;`,
    `var S=String;S.fromCharCode=function(){return 'custom';};var result=String.fromCharCode(65);`,
    `Object.defineProperty(globalThis,'atob',{value:function(){return 'custom';}});var result=atob('aGVsbG8=');`];
  for(const source of sources){const out=run(source);assert.equal(result(out.code),result(source));}
});
test('linearizes deterministic state-switch loops with state reads and variable hoisting intact',()=>{
 const samples=[
   `function run(){var s=0,log=[];while(s!==3){switch(s){case 0:log.push(s);s=2;break;case 1:log.push(s);s=3;break;case 2:log.push(s);s=1;continue;case 8:var hidden=7;s=3;break;}}return [log,s,hidden];}var result=run();`,
   `function run(){var s='start',log=[];for(;;){switch(s){case 'start':log.push(s);s='end';break;case 'end':return [log,s];}}}var result=run();`
 ];
 for(const source of samples){const out=run(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.stateDispatchers,1);assert.doesNotMatch(out.code,/switch \(/);}
});
test('retains state-switch cycles, external writes, lexical declarations and fallthrough',()=>{
 for(const source of [
  `function f(){var s=0;while(true){switch(s){case 0:s=1;break;case 1:s=0;break;}}}`,
  `function f(){var s=0;function mutate(){s=1;}while(s!==2){switch(s){case 0:mutate();s=2;break;}}}`,
  `function f(){var s=0;while(s!==2){switch(s){case 0:let value=7;s=2;break;}}}`,
  `function f(){var s=0;while(s!==2){switch(s){case 0:s=1;case 1:s=2;break;}}}`
 ])assert.equal(run(source).stats.stateDispatchers,0);
});
test('follows global and native aliases when deciding whether substitutions remain valid',()=>{
 const samples=[`var x=3;const target=globalThis;Object.assign(target,{x:9});var result=x;`,
   `const native=globalThis.String;native.fromCharCode=()=> 'custom';var result=String.fromCharCode(65);`,
   `''.constructor.prototype.trim=()=> 'custom';var result='hello'.trim();`];
 for(const source of samples){const out=run(source);assert.equal(result(out.code),result(source));}
});
