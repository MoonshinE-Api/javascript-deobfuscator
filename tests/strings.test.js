import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import generatorModule from '@babel/generator';
import { resolveStrings } from '../src/strings.js';
const generate = generatorModule.default ?? generatorModule;
function transform(source) { const ast = parse(source); const stats = resolveStrings(ast); return { stats, code: generate(ast).code }; }
function result(source) { const context = {}; vm.runInNewContext(source, context, { timeout: 1000 }); return JSON.stringify(context.result); }
function fixture(extra = '', decoder = 'return (decode=function(i,j){return a[i-=100]})(i,j)') {
  return `var effects=[];
    function table(){var a=["11","22","33","pageX"];return(table=function(){return a})()}
    function decode(i,j){var a=table();${decoder}}
    var before=decode(100);
    (function(e){for(var f=decode,d=e();;)try{if(parseInt(f(100))===22)break;d.push(d.shift())}catch(error){d.push(d.shift())}})(table);
    function side(){effects.push("side");return 102}
    var alias=(side(),decode);${extra}
    var index=102; var result=[before,alias(index),alias((side(),102)),effects];`;
}
test('solves rotation and aliases without executing input or removing side effects', () => {
  const source = fixture();
  const output = transform(source);
  assert.equal(result(output.code), result(source));
  assert.equal(output.stats.rotationsSolved, 1);
  assert.equal(output.stats.tables[0].rotation, 1);
  assert.equal(output.stats.decodedCalls, 1);
  assert.match(output.code, /alias\(\(side\(\), 102\)\)/);
  assert.match(output.code, /before = decode\(100\)/);
});
test('supports assignment and comma-return decoder variants', () => {
  for (const decoder of [
    'decode=function(i,j){return a[i-=100]};return decode(i,j)',
    'return decode=function(i,j){return a[i-=100]},decode(i,j)'
  ]) {
    const source = fixture('', decoder);
    const output = transform(source);
    assert.equal(result(output.code), result(source));
    assert.equal(output.stats.decodedCalls, 1);
  }
});
test('leaves lookups intact when the table escapes and may mutate', () => {
  const source = fixture('table()[2]="mutated";');
  const output = transform(source);
  assert.equal(output.stats.decodedCalls, 0);
  assert.equal(result(output.code), result(source));
});
test('does not assume an index variable is initialized before its declaration', () => {
  const source = fixture('var early=alias(later);var later=102;').replace('var result=[before,', 'var result=[early,before,');
  const output = transform(source);
  assert.equal(result(output.code), result(source));
  assert.match(output.code, /early = alias\(later\)/);
});
test('rejects rotation loops with extra effects', () => {
  const source = fixture().replace('d.push(d.shift())}catch', 'effects.push("turn");d.push(d.shift())}catch');
  const output = transform(source);
  assert.equal(output.stats.rotationsSolved, 0);
  assert.equal(result(output.code), result(source));
});
test('does not execute arbitrary input', () => {
  globalThis.__stringResolverExecuted = false;
  transform('globalThis.__stringResolverExecuted=true;throw new Error("input executed")');
  assert.equal(globalThis.__stringResolverExecuted, false);
  delete globalThis.__stringResolverExecuted;
});

test('recognizes expanded memoization, temporary decoder reads and while rotation', () => {
  const source = `function table(){const values=['11','22','33','pageX'];table=function(){return values;};return table();}
    function decode(i,j){const values=table();decode=function(index,unused){index=index-100;let value=values[index];return value;};return decode(i,j);}
    (function(factory,target){const alias=decode;const values=factory();while(!![]){try{const sum=parseInt(alias(100));if(sum===target){break;}else{values.push(values.shift());}}catch(error){values.push(values.shift());}}})(table,22);
    const alias=decode;var result=[alias(100),alias(102)];`;
  const out=transform(source);assert.equal(result(out.code),result(source));
  assert.equal(out.stats.rotationsSolved,1);assert.equal(out.stats.decodedCalls,2);
  for(const changed of [source.replace('let value=values[index];','let value=values[index];globalThis.sideEffect=1;'),
    source.replace('const sum=parseInt(alias(100));','const sum=parseInt(alias(100));globalThis.sideEffect=1;'),
    source.replace('return table();','return table(7);')])assert.equal(transform(changed).stats.decodedCalls,0);
});
test('decodes closed unrotated memoized factories while keeping observable decoder identities intact',()=>{
 const base=`function table(){const values=['hello','canvas','language'];table=function(){return values;};return table();}
  function decode(i){const values=table();return(decode=function(i){return values[i-=100];})(i);}`;
 const source=base+`const alias=decode;var result=[alias(100),alias(101)];`,out=transform(source);
 assert.equal(result(out.code),result(source));assert.equal(out.stats.unrotatedTables,1);assert.equal(out.stats.decodedCalls,2);
 for(const suffix of [`const alias=decode;var result=[decode(100),decode===alias];`,`var result=[decode(100),decode.name];`,`table()[0]='changed';var result=decode(100);`]){
  const source=base+suffix,out=transform(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.decodedCalls,0);
 }
});
