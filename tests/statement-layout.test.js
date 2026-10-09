import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {statementLayout} from '../src/statement-layout.js';
const generate=generatorModule.default??generatorModule;
test('statement expansion preserves dynamic scope, completion, abrupt exits and directive status',()=>{
  const sources=[
    `var o={a:2},a=9;with(o){a+=3,a*=2;}[o.a,a];`,
    `var log=[];function f(){with({x:4})return log.push(x),x+1;}[f(),log];`,
    `var log=[];try{with({x:4})throw log.push(x),x;}catch(e){log.push(e);}log;`,
    `function f(){('use strict',1);return this===undefined;}f();`,
    `var log=[];var a=log.push(1),b=log.push(2);log;`,
    `var x=0;outer:with({}){x++,x++;break outer;}x;`,
    `var x=0;switch(1){case 1:x++,x++;break;}x;`,
    `var x=0;if(true)x++,x++;x;`,
    `7;with({}){var a=1,b=2;}`
  ];
  for(const source of sources){const ast=parse(source);statementLayout(ast);const out=generate(ast).code;parse(out);assert.equal(JSON.stringify(vm.runInNewContext(out)),JSON.stringify(vm.runInNewContext(source)),source);}
});
