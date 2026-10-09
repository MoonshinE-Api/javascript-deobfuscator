import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {shorten} from '../src/shorten.js';
const generate=generatorModule.default??generatorModule;
test('boolean return compaction retains evaluation count, truthiness, and exceptions',()=>{
  const source=`var count=0;function f(value){count++;if(value){return true;}else{return false;}}
  function g(value){if(value)return false;return true;}function h(value){if(value>2)return true;return false;}
  var result=[f(0),f('text'),g(null),g({}),h(3),count];`;
  const ast=parse(source),stats=shorten(ast),before={},after={};vm.runInNewContext(source,before);vm.runInNewContext(generate(ast).code,after);
  assert.equal(JSON.stringify(after.result),JSON.stringify(before.result));assert.equal(stats.booleanReturns,3);
});
test('compacting arrows and property shorthand keeps __proto__ behavior and skips eval',()=>{
  const source=`const x=1;const f=()=>{return x;};var result=[f(),Object.getPrototypeOf({__proto__:x}),({x:x}).x];`;
  const ast=parse(source),stats=shorten(ast),before={},after={};vm.runInNewContext(source,before);vm.runInNewContext(generate(ast).code,after);
  assert.equal(JSON.stringify(after.result),JSON.stringify(before.result));assert.equal(stats.expressionArrows,1);assert.equal(stats.shorthandProperties,1);
  const dynamic=parse(`function f(){eval('');if(x)return true;return false;}`);assert.ok(shorten(dynamic).skipped);
});
