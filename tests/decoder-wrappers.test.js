import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {decoderWrappers} from '../src/decoder-wrappers.js';
const generate=generatorModule.default??generatorModule;
const source=`function run(){function d(a,b){return [a,b];}function inner(a,b){return d(b-10,a+2);}function outer(a,b){return inner(b,a);}return outer(13,4);}var result=run();`;
function transform(source){const ast=parse(source),stats=decoderWrappers(ast);return {code:generate(ast).code,stats};}
const run=source=>{const c={};vm.runInNewContext(source,c,{timeout:500});return JSON.stringify(c.result);};
test('unwraps nested constant decoder arguments, offsets and reordering',()=>{
 const out=transform(source);assert.equal(run(out.code),run(source));assert.equal(out.stats.inlinedCalls,2);assert.match(out.code,/return d\(3, 6\)/);
});
test('retains argument effects, shadowed targets, uncertain initialization and reflection',()=>{
 const inputs=[source.replace('outer(13,4)','outer((effects.push(13),13),4)').replace('function run()','var effects=[];function run()'),source.replace('return outer(13,4);','function call(d){return inner(13,4);}return call(()=>99);'),source.replace('return outer(13,4);',`return [outer(13,4),d.caller];`),`function run(){function wrap(x){return target(x);}try{return wrap(2);}catch(e){return e.name;}const target=x=>x;}var result=run();`];
 for(const input of inputs){const out=transform(input);assert.equal(run(out.code),run(input));}
 assert.equal(transform(inputs[0]).stats.inlinedCalls,0);assert.equal(transform(inputs[2]).stats.inlinedCalls,0);assert.equal(transform(inputs[3]).stats.inlinedCalls,0);
});
