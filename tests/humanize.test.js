import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import generatorModule from '@babel/generator';
import { humanize } from '../src/humanize.js';
import { unpack } from '../src/unpack.js';
const generate = generatorModule.default ?? generatorModule;

function result(source) {
  const context = {};
  vm.runInNewContext(source, context, { timeout: 1000 });
  return JSON.stringify(context.result);
}
function readable(source) {
  const ast = parse(source);
  const stats = humanize(ast, { imports: new Map(), exportMaps: new Map(), modulePaths: [] });
  return { code: generate(ast).code, stats };
}

test('expands control flow without changing trusted fixture side effects', () => {
  const source = `var log=[];
    function add(x){ log.push(x);return x; }
    function f(x){ if(add("test"),x) return add(1),x?add(2):add(3); else return add(4); }
    for(var i=0;i<3;i++) { i && add("and"); i || add("or"); i===1 ? add("yes") : add("no"); f(i); }
    var result=log;`;
  const transformed = readable(source);
  assert.equal(result(transformed.code), result(source));
  assert.ok(transformed.stats.expandedConditions > 0);
});

test('inferred names respect nested scope and object property names', () => {
  const source = `var result; function f(e){var t=e.token;function g(token){return t+token;}return {token:t,value:g("!")};} result=f({token:"abc"});`;
  const transformed = readable(source);
  assert.equal(result(transformed.code), result(source));
  assert.ok(transformed.stats.renames.length > 0);
});

test('preserves break, continue, nullish expressions and call receivers', () => {
  const source = `var log=[];var obj={value:7,get:function(){return this.value}};
    outer: for(var i=0;i<4;i++){if(i===2)continue; if(i===3)break outer;log.push(obj.get());}
    var result=[log,null??"fallback",false??"kept"];`;
  assert.equal(result(readable(source).code), result(source));
});

test('skips inference with dynamic scope', () => {
  const transformed = readable('var t={token:"x"}; eval("t.token");');
  assert.equal(transformed.stats.renames.length, 0);
  assert.match(transformed.stats.skipped, /eval/);
});

test('simplifies recognized property builders and keeps __proto__ an own property', () => {
  const source = `var result;(function(){var e={
    1:function(e,t,n){n.d(t,{A:function(){return f}});function f(e,t,n){t in e?Object.defineProperty(e,t,{value:n,enumerable:true,configurable:true,writable:true}):e[t]=n;return e;}},
    2:function(e){e.exports="ok";}},t={};
    function n(r){if(t[r])return t[r].exports;var o=t[r]={exports:{}};e[r](o,o.exports,n);return o.exports;}
    n.d=function(e,t){for(var r in t)Object.defineProperty(e,r,{get:t[r]});};
    var a=n(1),x;var y=(x={},(0,a.A)(x,"token","hello"),(0,a.A)(x,"__proto__","own"));
    var z=(0,a.A)((0,a.A)({},"a",1),"b",2);
    result=[y.token,y.__proto__,Object.hasOwn(y,"__proto__"),z.a,z.b,x===y];})();`;
  const transformed = unpack(source);
  assert.equal(result(transformed.code), result(source));
  assert.ok(transformed.stats.readability.propertyBuilders >= 2);
});

test('names a literal namespace export without copying an exported object', () => {
  const source = `var result;(function(){var e={
    1:function(e,t,n){n.d(t,{A:function(){return a},B:function(){return b}});var a="ready";var b={ON_READY:"onReady"};},
    2:function(e){e.exports=2;}},t={};
    function n(r){if(t[r])return t[r].exports;var o=t[r]={exports:{}};e[r](o,o.exports,n);return o.exports;}
    n.d=function(e,t){for(var r in t)Object.defineProperty(e,r,{get:t[r]});};
    var a=n(1);a.B.ON_READY="changed";result=[a.A,a.B.ON_READY];})();`;
  const transformed = unpack(source);
  assert.equal(result(transformed.code), result(source));
  assert.ok(transformed.stats.readability.exportAliases >= 2);
});

test('does not turn a destructuring property write into an alias write', () => {
  const source = `var result;(function(){var e={
    1:function(e,t,n){n.d(t,{A:function(){return a}});var a="ready";},
    2:function(e){e.exports=2;}},t={};
    function n(r){if(t[r])return t[r].exports;var o=t[r]={exports:{}};e[r](o,o.exports,n);return o.exports;}
    n.d=function(e,t){for(var r in t)Object.defineProperty(e,r,{get:t[r]});};
    var a=n(1);[a.A]=["other"];result=a.A;})();`;
  assert.equal(result(unpack(source).code), result(source));
});

test('rebuilds import references after property builders replace their parent subtrees', () => {
  const source=`var result;(function(){var e={
    1:function(e,t,n){n.d(t,{A:function(){return f}});function f(e,t,n){t in e?Object.defineProperty(e,t,{value:n,enumerable:true,configurable:true,writable:true}):e[t]=n;return e;}},
    2:function(e,t,n){n.d(t,{KEY:function(){return k}});var k='token';}},t={};
    function n(r){if(t[r])return t[r].exports;var o=t[r]={exports:{}};e[r](o,o.exports,n);return o.exports;}
    n.d=function(e,t){for(var r in t)Object.defineProperty(e,r,{get:t[r]});};
    var a=n(1),k=n(2);var value=(0,a.A)({},k.KEY,3);result=value.token;})();`;
  const out=unpack(source);assert.equal(result(out.code),result(source));
  assert.equal(out.stats.readability.propertyBuilders,1);assert.ok(out.stats.readability.aliasedReads>0);
});
