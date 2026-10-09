import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import {batchRename} from '../src/batch-rename.js';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule;
function rename(source,choose){const ast=parse(source,{sourceType:'unambiguous'}),plans=new Map(),seen=new Set();traverse(ast,{Scopable(p){for(const binding of Object.values(p.scope.bindings))if(!seen.has(binding)){seen.add(binding);const name=choose(binding);if(name)plans.set(binding,name);}}});batchRename(ast,plans);return generate(ast).code;}
function result(source){const context={};vm.runInNewContext(source,context,{timeout:1000});return JSON.stringify(context.result);}
test('batch naming preserves assignments, destructuring, shorthand keys and shadowed names',()=>{
 const source='let a=1,b=2;({a,b}={a:3,b:4});a++;function c(a){return {a,b,[a]:b};}globalThis.result=[{a,b},c(8),a,b];';
 const code=rename(source,b=>b.scope.path.isProgram()?({a:'firstValue',b:'secondValue',c:'makeObject'}[b.identifier.name]):b.identifier.name==='a'?'argumentValue':null);
 assert.equal(result(code),result(source));assert.match(code,/a: firstValue/);assert.match(code,/argumentValue/);
});
test('declaration names resolve by binding identity when a parameter has the same spelling',()=>{
 const source='function a(a){return a+1;}globalThis.result=a(8);';
 const code=rename(source,b=>b.identifier.name==='a'?(b.scope.path.isProgram()?'increment':'value'):null);
 assert.equal(result(code),result(source));assert.match(code,/function increment\(value\)/);
});
test('exports keep their public names while imported locals and computed keys change correctly',()=>{
 const code=rename('import {value as a} from "fixture";export function b(c){return {[a]:c};}export {a};',b=>({a:'importedValue',b:'buildMap',c:'inputValue'}[b.identifier.name]));
 parse(code,{sourceType:'module'});assert.match(code,/buildMap as b/);assert.match(code,/importedValue as a/);assert.match(code,/\[importedValue\]: inputValue/);
});
test('many bindings are renamed together without losing sibling references',()=>{
 const source='function run(){'+Array.from({length:600},(_,i)=>`let v${i}=${i};`).join('')+'return ['+Array.from({length:600},(_,i)=>`v${i}`).join(',')+'];}globalThis.result=run();';
 const code=rename(source,b=>/^v\d+$/.test(b.identifier.name)?'value'+b.identifier.name.slice(1):null);assert.equal(result(code),result(source));assert.match(code,/value599/);
});
test('labeled break and continue use a separate namespace from shadowed variables',()=>{
 const source='let a=7;globalThis.result=[];a:for(let i=0;i<4;i++){let a=0;if(i<2)continue a;result.push(i);break a;}';
 const code=rename(source,b=>b.identifier.name==='a'?(b.scope.path.isProgram()?'outerValue':'innerValue'):null);
 parse(code);assert.equal(result(code),result(source));assert.match(code,/continue a/);assert.match(code,/break a/);
});
test('a conflicting rename plan is rejected instead of silently capturing a reference',()=>{
 const source='function outer(a){function inner(b){return [a,b];}return inner(9);}globalThis.result=outer(3);';
 assert.throws(()=>rename(source,b=>['a','b'].includes(b.identifier.name)?'value':null),/changed an identifier binding/);
});
test('computed method keys resolve outside method parameters and switch tests outside case locals',()=>{
 const sources=["let a='method';class b{[a](a){return a;}}globalThis.result=[new b().method(7),a];",'let a=1;switch(a){case 1:let a=2;globalThis.result=a;}'];
 for(const source of sources){const code=rename(source,b=>b.identifier.name==='a'?(b.scope.path.isProgram()?'outerValue':'innerValue'):null);assert.equal(result(code),result(source));}
});
