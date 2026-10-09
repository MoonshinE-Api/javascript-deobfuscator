import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {resolveCachedStrings} from '../src/cached-strings.js';
import {unpack} from '../src/unpack.js';
import {base91Fixture} from './helpers/base91-fixture.js';
const generate=generatorModule.default??generatorModule;
function transform(source){const ast=parse(source),stats=resolveCachedStrings(ast);return {code:generate(ast).code,stats};}
const run=source=>{const context={};vm.runInNewContext(source,context,{timeout:1000});return JSON.stringify(context.result);};
const fixture=`function run(){var cache={},table=['hi','bye'];function decode(s){return s.toUpperCase();}
  function d(i){return void 0===cache[i]?cache[i]=decode(table[i]):cache[i];}
  return [d(0),d(1),d(0)];}var result=run();`;
test('decodes private memoized primitive-helper tables without executing input',()=>{
 const out=transform(fixture);assert.equal(run(out.code),run(fixture));assert.equal(out.stats.decodedCalls,3);assert.match(out.code,/"HI"/);
});
test('different decoders sharing a cache preserve first-write results',()=>{
 const source=fixture.replace('return [d(0),d(1),d(0)];',`function lower(s){return s.toLowerCase();}function e(i){return void 0===cache[i]?cache[i]=lower(table[i]):cache[i];}return [e(0),d(0),d(1),e(1)];`);
 const out=transform(source);assert.equal(run(out.code),run(source));assert.equal(out.stats.cachePreservedCalls,4);assert.match(out.code,/readDecodedString/);
 assert.equal(run(unpack(source).code),run(source));
});
test('mutable, escaping, shadowed and dynamically initialized caches remain observable',()=>{
 const sources=[fixture.replace('return [d(0),d(1),d(0)];',`cache[0]='changed';return [d(0)];`),
 fixture.replace('return [d(0),d(1),d(0)];',`table[0]='changed';return [d(0)];`),
 fixture.replace('return [d(0),d(1),d(0)];',`var object={d};return [object.d(0)];`),
 `function run(){var cache,table;function decode(s){return s.toUpperCase();}function d(i){return void 0===cache[i]?cache[i]=decode(table[i]):cache[i];}try{throw 1;var cache={},table=['hi'];}catch(e){}return d(0);}var result;try{result=run();}catch(e){result=e.name;}`];
 for(const source of sources){const out=transform(source);assert.equal(run(out.code),run(source));}
 assert.equal(transform(sources[0]).stats.decodedCalls,0);assert.equal(transform(sources[1]).stats.decodedCalls,0);
});
test('captures and decoder variables must initialize before replaced calls',()=>{
 const source=`function run(){var cache={},table=['hi'];function decode(s){return prefix+s;}function d(i){return void 0===cache[i]?cache[i]=decode(table[i]):cache[i];}try{return d(0);}catch(e){return e.name;}const prefix='ok';}var result=run();`;
 assert.equal(run(transform(source).code),run(source));assert.equal(transform(source).stats.decodedCalls,0);
 const variable=fixture.replace('function decode(s){return s.toUpperCase();}',`var decode=function(s){return s.toUpperCase();};`).replace('return [d(0),d(1),d(0)];','return [d(0)];');assert.equal(run(transform(variable).code),run(variable));
});
test('top-level shared caches get a facade in their own scope',()=>{
 const source=`var cache={},table=['hi'];function upper(s){return s.toUpperCase();}function lower(s){return s.toLowerCase();}function d(i){return void 0===cache[i]?cache[i]=upper(table[i]):cache[i];}function e(i){return void 0===cache[i]?cache[i]=lower(table[i]):cache[i];}var result=[e(0),d(0)];`;
 const out=transform(source);assert.equal(run(out.code),run(source));assert.equal(out.stats.cachePreservedCalls,2);
});
test('metadata wrappers cannot hide writes and async wrappers retain promises',()=>{
 const source=fixture.replace('return [d(0),d(1),d(0)];',`function lower(s){return s.toLowerCase();}function e(i){table[0]='changed';return void 0===cache[i]?cache[i]=lower(table[i]):cache[i];}return [e(0),d(0)];`);
 const out=transform(source);assert.equal(run(out.code),run(source));assert.equal(out.stats.decodedCalls,0);
 assert.equal(transform(fixture.replace('function d(i)','async function d(i)')).stats.decodedCalls,0);
});
test('recognizes custom Base91 bytes, exposes ASCII and retains Unicode conversion',()=>{
 const source=base91Fixture(),out=transform(source);assert.equal(run(out.code),run(source));assert.equal(out.stats.base91Tables,1);assert.equal(out.stats.decodedCalls,1);assert.match(out.code,/"hello"/);assert.match(out.code,/d\(1\)/);
});
test('global codec replacements require captured aliases and method mutations block decoding',()=>{
 const after=base91Fixture({after:`var key='TextDecoder';globalThis[key]=true;`}),out=transform(after);assert.equal(run(out.code),run(after));assert.equal(out.stats.decodedCalls,1);
 const before=base91Fixture({before:`globalThis.TextDecoder=function(){this.decode=function(){return 'different';};};`}),early=transform(before);assert.equal(run(early.code),run(before));assert.equal(early.stats.decodedCalls,0);
 const mutation=base91Fixture({after:`String.prototype.indexOf=function(){return 0;};`});assert.equal(transform(mutation).stats.decodedCalls,0);
 assert.equal(transform(base91Fixture({after:`patch(String);`})).stats.decodedCalls,0);
 assert.equal(transform(base91Fixture({after:`patch(TextDecoderAlias);`})).stats.decodedCalls,0);
 assert.equal(transform(base91Fixture({after:`delete String.prototype.indexOf;`})).stats.decodedCalls,0);
});
