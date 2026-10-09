import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import generatorModule from '@babel/generator';
import { nameBindings } from '../src/namer.js';
import {unpack} from '../src/unpack.js';
const generate = generatorModule.default ?? generatorModule;
function run(source) {
  const ast = parse(source, { sourceType: 'unambiguous' });
  const stats = nameBindings(ast);
  const code = generate(ast).code;
  parse(code, { sourceType: 'unambiguous' });
  return { code, stats };
}
test('hexadecimal names gain API and initializer roles while public keys and inspected names stay intact',()=>{
 const source=`function run(_0xaaa){const _0xbbb=new TextEncoder();const _0xccc=_0xbbb.encode(_0xaaa);const _0xddd=[1,2,3];return {_0xccc,bytes:_0xccc.length,items:_0xddd};}var result=run('abc');`;
 const out=run(source);assert.doesNotMatch(out.code,/\b(?:const|function) _0x[0-9a-f]+/i);
 assert.match(out.code,/plainText/);assert.match(out.code,/textEncoder/);assert.match(out.code,/encodedBytes/);assert.match(out.code,/_0xccc: encodedBytes/);
 const before={TextEncoder},after={TextEncoder};vm.runInNewContext(source,before);vm.runInNewContext(out.code,after);
 assert.equal(JSON.stringify(after.result),JSON.stringify(before.result));
 const inspected=run(`function _0xabc(){return 7;}var result=_0xabc.name;`);assert.match(inspected.code,/function _0xabc/);
});
test('full readability pipeline handles opaque hex names without invalid underscore cleanup',()=>{
 const source=`globalThis.result=(function(_0x123){var _0xabc=String(_0x123);return _0xabc;})(7);`;
 const out=unpack(source);assert.doesNotMatch(out.code,/_0x(?:123|abc)/);
 const after={};vm.runInNewContext(out.code,after);assert.equal(after.result,'7');
});
test('names event, replacement callbacks and numeric loop counters from usage',()=>{
 const source=`function f(){var log=[];var object={addEventListener(type,callback){callback({data:7});}};
   object.addEventListener('message',function(e){log.push(e.data);});for(var i=0;i<2;i++)log.push(i);
   var text='hello'.replace(/(h)/,function(a,b){return b.toUpperCase();});return [log,text];}var result=f();`;
 const out=run(source);assert.match(out.code,/messageEvent/);assert.match(out.code,/itemIndex/);assert.match(out.code,/matchedText/);assert.match(out.code,/captureGroup/);
 const before={},after={};vm.runInNewContext(source,before);vm.runInNewContext(out.code,after);assert.equal(JSON.stringify(after.result),JSON.stringify(before.result));
});
test('simultaneous parent and child suggestions do not capture an outer reference',()=>{
 const source='var userOptions=9;function f(e){function g(t){return [e,t];}return g(userOptions);}f(userOptions);globalThis.result=f(3);';
 const {code}=run(source),before={},after={};vm.runInNewContext(source,before);vm.runInNewContext(code,after);assert.equal(JSON.stringify(after.result),JSON.stringify(before.result));
});

test('names iterator results and property-key callbacks, preserving trusted fixture results', () => {
  const source = `var result; function f(e) { var t=e.next(); return t.done ? null : t.value; }
    function g(e) { return Object.keys(e).reduce(function(t,n){return t+n;}, ''); }
    result=[f({next(){return {done:false,value:7}}}),g({hello:1,world:2})];`;
  const { code, stats } = run(source);
  assert.match(code, /iteratorResult/);
  assert.match(code, /propertyKey/);
  assert.match(code, /accumulator/);
  assert.ok(stats.renames.every(entry => entry.reason && entry.confidence >= .78));
  const before = {}, after = {};
  vm.runInNewContext(source, before); vm.runInNewContext(code, after);
  assert.equal(JSON.stringify(after.result), JSON.stringify(before.result));
});

test('avoids capturing globals, outer bindings, and nested names', () => {
  const source = `var parsedValue=10, result;
    function f(){var e=JSON.parse('2');return (()=>parsedValue+e)();} result=f();`;
  const { code } = run(source);
  assert.match(code, /parsedValue2/);
  const after = {}; vm.runInNewContext(code, after);
  assert.equal(after.result, 12);
});

test('preserves public property names and dynamic eval/with bindings', () => {
  const source = `var result; function f(){var e=JSON.parse('2');return {e};} result=f().e;`;
  const { code } = run(source);
  const after = {}; vm.runInNewContext(code, after);
  assert.equal(after.result, 2);
  assert.match(code, /e: parsedValue/);
  for (const source of [`function f(){var e=JSON.parse('2');return eval('e');}`, `with(x){var e=JSON.parse('2');}`]) {
    const { stats } = run(source);
    assert.equal(stats.renames.length, 0);
    if(source.includes('eval('))assert.match(stats.skipped, /eval/);
  }
});

test('propagates argument roles but leaves contradictory suggestions alone', () => {
  const source = `function f(e){return e;} function g(userOptions){f(userOptions);}
    function h(e){return e;} function q(firstChoice,secondChoice){h(firstChoice);h(secondChoice);}`;
  const { code, stats } = run(source);
  assert.match(code, /function f\(userOptions\)/);
  assert.match(code, /function h\(e\)/);
  assert.ok(stats.renames.some(entry => entry.reason === 'caller passes userOptions'));
});

test('recognizes origin and attribute helpers and preserves fixture behavior', () => {
  const source = `var result; var p=function(e){return !e || e==='null' || e==='file://' ? '*' : e;};
    var d=function(e,t){t.setAttribute('aria-hidden',e);};
    var element={setAttribute(name,value){this[name]=value;}};d(true,element);result=[p('file://'),p('https://example.test'),element['aria-hidden']];`;
  const { code } = run(source); assert.match(code, /normalizeMessageOrigin/); assert.match(code, /setAriaHidden/);
  const before={},after={}; vm.runInNewContext(source,before);vm.runInNewContext(code,after);
  assert.equal(JSON.stringify(after.result),JSON.stringify(before.result));
});

test('recognizes array-copy compiler helpers and names their parameters', () => {
  const source=`var result; function a(e,t){if(t==null||t>e.length)t=e.length;for(var n=0,r=new Array(t);n<t;n++)r[n]=e[n];return r;}
    result=a([1,2,3],2);`;
  const {code}=run(source);assert.match(code,/function copyArrayPrefix\(source, length\)/);
  const after={};vm.runInNewContext(code,after);assert.equal(JSON.stringify(after.result),'[1,2]');
});
