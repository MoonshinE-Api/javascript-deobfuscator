import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import generatorModule from '@babel/generator';
import { polish } from '../src/polish.js';
import { unpack } from '../src/unpack.js';
import { codeMap } from '../src/code-map.js';
const generate = generatorModule.default ?? generatorModule;
function run(source) { const context = {}; vm.runInNewContext(source, context, { timeout: 1000 }); return JSON.stringify(context.result); }
function transform(source) {
  const ast = parse(source);
  const stats = polish(ast, { modulePaths: [] });
  return { code: generate(ast).code, stats };
}
test('simultaneous cleanup of nested names preserves captured outer values',()=>{
 const source='function f(_value){function g(_value2){return [_value,_value2];}return g(9);}globalThis.result=f(3);';
 assert.equal(run(transform(source).code),run(source));
});

test('cleans sibling local names without capturing a nested parameter', () => {
  const source = 'var _token3="outer";function a(token){return [_token3,token]}function b(){var _items27=[1];return _items27}function c(){var _items42=[2];return _items42}var result=[a("inner"),b(),c()];';
  const output = transform(source);
  assert.equal(run(output.code), run(source));
  assert.doesNotMatch(output.code, /_items27|_items42/);
  assert.match(output.code, /var items = \[1\]/);
  assert.match(output.code, /var items = \[2\]/);
});

test('expands void returns while retaining evaluation and finally order', () => {
  const source = 'var log=[];function f(x){try{return void(x?(log.push(1),log.push(2)):log.push(3))}finally{log.push(4)}}var output=f(true);var result=[log,output===void 0];';
  const output = transform(source);
  assert.equal(run(output.code), run(source));
  assert.equal(output.stats.expandedVoidReturns, 1);
});

test('reorders primitive comparisons without reordering object coercions', () => {
  const source = 'var log=[];RegExp.prototype.toString=function(){log.push("regex");return "a"};var obj={[Symbol.toPrimitive]:function(){log.push("obj");return "b"}};var x=3;var comparison=/a/<obj;var result=[comparison,log,2<x,"number"===typeof x];';
  const output = transform(source);
  assert.equal(run(output.code), run(source));
  assert.equal(output.stats.reorderedComparisons, 2);
});

test('preserves shadowed undefined and loop labels', () => {
  const source = 'function f(undefined){return void 0}var values=[];outer:for(var i=0;i<4;i++)if(i===2)break outer;else values.push(i);var result=[f(7)===void 0,values];';
  assert.equal(run(transform(source).code), run(source));
});

test('compiler facades retain live self-replacing functions', () => {
  const source = `var result;(function(){var e={
    1:function(e,t,n){function r(e){r=typeof Symbol==="function"&&typeof Symbol.iterator==="symbol"?function(e){return typeof e}:function(e){return e&&typeof Symbol==="function"&&e.constructor===Symbol&&e!==Symbol.prototype?"symbol":typeof e};return r(e)}n.d(t,{A:function(){return r}})},
    2:function(e){e.exports=2}},t={};
    function n(r){if(t[r])return t[r].exports;var o=t[r]={exports:{}};e[r](o,o.exports,n);return o.exports;}
    n.d=function(e,t){for(var r in t)Object.defineProperty(e,r,{get:t[r]})};
    var a=n(1),first=a.A;var value=(0,a.A)("hello");var second=a.A;result=[first===second,value,(0,a.A)(123)];})();`;
  const output = unpack(source);
  assert.equal(run(output.code), run(source));
  assert.equal(output.stats.readability.polish.helperFacades, 1);
  assert.match(output.code, /get typeOf/);
});

test('code map identifies public methods and named event handlers', () => {
  const app = 'export default function clientEntry(){function handleReady(){};var clientApi={setConfig:function(){},getConfig:function(){},run:function(){}};eventBus.on("ready",handleReady)}';
  const doc = codeMap(app, []);
  assert.match(doc, /setConfig/);
  assert.match(doc, /ready \| handleReady/);
});
