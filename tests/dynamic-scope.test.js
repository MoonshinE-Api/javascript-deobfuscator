import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {unpack} from '../src/unpack.js';
const run=source=>{const calls=[],context={fetch:url=>calls.push(url)};vm.runInNewContext(source,context,{timeout:1000});return JSON.stringify([context.result,calls]);};

test('with barriers preserve dynamic lookups while unrelated code gets decoded and named',()=>{
  const source=`function run(){function f(t){fetch(t);return ['a','b'].join('-');}
    var n=4;var obj={n:7,f:()=> 'object'};var local;
    with(obj){local=[n,f('ignored')];n=9;}
    return [local,n,obj.n,f('url')];}var result=run();`;
  const output=unpack(source);assert.equal(run(output.code),run(source));
  assert.ok(output.stats.advanced.literalCalls);assert.match(output.code,/requestUrl/);
  assert.match(output.code,/with \(obj\)/);assert.match(output.code,/f\('ignored'\)|f\("ignored"\)/);
});

test('with declarations, assignments, closures and unscopables keep their original bindings',()=>{
  const sources=[
    `function run(){var n=2;var obj={n:7};with(obj){var n=4;}return [n,obj.n];}var result=run();`,
    `function run(){var n=2;var obj={n:7};with(obj){n++;}return [n,obj.n];}var result=run();`,
    `function run(){var n=2;var obj={n:7};var f;with(obj){f=function(){return n;};}return f();}var result=run();`,
    `function run(){var n=2;var obj={n:7,[Symbol.unscopables]:{n:true}};with(obj){n+=3;}return [n,obj.n];}var result=run();`
  ];
  for(const source of sources){const output=unpack(source);assert.equal(run(output.code),run(source),source);}
});

test('direct eval still preserves lexical names and dynamic values',()=>{
  const source=`function run(){var n=3;eval('n=7');return n;}var result=run();`;
  const output=unpack(source);assert.equal(run(output.code),run(source));assert.match(output.code,/var n/);
});
