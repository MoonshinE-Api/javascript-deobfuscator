import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {readableFlow} from '../src/readable-flow.js';
const generate=generatorModule.default??generatorModule;
test('expands var headers without changing completion, initialization or captured loop variables',()=>{
 const sources=[`var calls=[];for(var i=0,n=3;i<n;i++)calls.push(()=>i);calls.map(f=>f());`,
 `7;for(var i=0,n=3;false;i++){};`,
 `var calls=[];for(var i=(calls.push('a'),0),n=(calls.push('b'),2);i<n;i++)calls.push(i);calls;`,
 `var calls=[];outer:for(var i=0,n=3;i<n;i++){if(i<2)continue outer;calls.push(i);}calls;`];
 for(const source of sources){const ast=parse(source),stats=readableFlow(ast),output=generate(ast).code;assert.equal(JSON.stringify(vm.runInNewContext(output)),JSON.stringify(vm.runInNewContext(source)));if(!source.includes('outer:'))assert.equal(stats.expandedForHeaders,1);}
 const ast=parse(`for(let i=0,n=3;i<n;i++){}`);assert.equal(readableFlow(ast).expandedForHeaders,0);
});
