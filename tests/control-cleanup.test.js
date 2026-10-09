import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {advanced} from '../src/advanced.js';
const generate=generatorModule.default??generatorModule;
function run(source){const ast=parse(source);const stats=advanced(ast);const code=generate(ast).code;parse(code);return {stats,code};}
function result(source){const context={};const completion=vm.runInNewContext(source,context,{timeout:1000});return JSON.stringify({result:context.result,completion});}
test('selects constant switches preserving fallthrough, nested breaks, defaults, hoists and completion',()=>{
 const sources=[
  `var log=[];switch(2){case 1:log.push('one');break;case 2:log.push('two');case 3:log.push('three');break;default:var hidden=9;}var result=[log,hidden];`,
  `var log=[];switch('x'){case 'x':if(true)break;log.push('bad');default:log.push('bad');}var result=log;`,
  `var log=[];switch(3){default:log.push('default');case 2:for(var i=0;i<3;i++){if(i===1)break;log.push(i);}break;}var result=log;`,
  `switch(9){case 1:var x=7;break;}var result=x;`,
  `switch(2){case 2:7;break;default:9;}`,`switch(null){case null:7;break;default:9;}`,
  `switch(2){case 2:_switchExit:{7;break _switchExit;}break;}`
 ];
 for(const source of sources){const out=run(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.constantSwitches,1);assert.doesNotMatch(out.code,/switch \(/);}
});
test('removes zero-iteration loops with initializer effects and declaration hoisting preserved',()=>{
 const sources=[
  `var log=[];for(var i=(log.push('init'),3);false;log.push('update')){var hidden=9;log.push('body');}var result=[log,i,hidden];`,
  `var log=[];while(false){var hidden=7;log.push('body');}var result=[hidden,log];`,
  `for(7;false;){};`, `for(let x=3;false;){};`, `while(![]){throw Error('bad');}`
 ];
 for(const source of sources){const out=run(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.deadLoops,1);}
});
test('expands do-while false exactly once, preserving break/continue targets and lexical scopes',()=>{
 const sources=[
  `var log=[];do{log.push(1);continue;log.push('bad');}while(false);var result=log;`,
  `var log=[];do{log.push(1);if(true)break;log.push('bad');}while(false);var result=log;`,
  `var log=[];do{for(var i=0;i<3;i++){if(i===1)continue;log.push(i);}let n=9;log.push(n);}while(false);var result=log;`,
  `do{7;continue;9;}while(false);`
 ];
 for(const source of sources){const out=run(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.singleIterationLoops,1);}
});
test('retains uncertain tests, switch lexical TDZ, labeled do-loops and Annex B functions',()=>{
 const sources=[`switch(2){case 1:let x=3;break;case 2:typeof x;}`,`switch(2){case side():7;break;}`,
  `while(false){function local(){return 7;}}`,`outer:do{continue outer;}while(false);`];
 for(const source of sources){const out=run(source);assert.equal(out.stats.constantSwitches,0);assert.equal(out.stats.deadLoops,0);assert.equal(out.stats.singleIterationLoops,0);}
});
