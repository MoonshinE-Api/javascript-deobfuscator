import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '@babel/parser';
import {humanReading} from '../src/human-reading.js';
import {dispatcherReading} from '../src/dispatcher-reading.js';

const facade=`var cache={};function d(index,text){if(undefined===cache[index])return cache[index]=text;else return cache[index];}`;
test('reading projection recognizes actual cache facades, not helper-like names',()=>{
 const out=humanReading(facade+`function ab(t){return t[d(1,'length')];}ab.name;`);
 assert.match(out.code,/\.length/);assert.equal(out.stats.literalCandidates,1);assert.equal(out.stats.renamedFunctions,1);assert.match(out.scope,/change runtime/);assert.match(out.code,/not execution/);parse(out.code);
 const fake=humanReading(`function _readDecodedString(i,s){log(i);return 'other';}obj[_readDecodedString(1,'length')];`);assert.equal(fake.stats.literalCandidates,0);
});
test('conflicts, lexical cache identity, declarations and shadowed undefined remain explicit',()=>{
 assert.equal(humanReading(facade+`d(1,'length');d(1,'other');`).stats.literalCandidates,0);
 assert.equal(humanReading(`function f(undefined){${facade}return d(1,'length');}`).stats.literalCandidates,0);
 const separate=`function f(){${facade}return d(1,'length');}function g(){${facade}return d(1,'other');}`;
 assert.equal(humanReading(separate).stats.literalCandidates,2);
});
test('large literal tables are retained separately, executable table elements stay inline',()=>{
 const strings=Array.from({length:40},(_,i)=>'encoded-data-'+i);
 const out=humanReading('var values='+JSON.stringify(strings)+';');assert.equal(out.tables.length,1);assert.deepEqual(out.tables[0].data,strings);assert.match(out.code,/__readingData/);
 assert.equal(humanReading('var values=['+strings.map(s=>JSON.stringify(s)).join(',')+',run()];').tables.length,0);
});
test('codec API mentions never hide the containing application or its nested functions',()=>{
 const source=`(function(){var a=globalThis.TextDecoder,b=globalThis.Uint8Array;var list=[];function run(){return 'application logic';}globalThis.result=run();list.join('');})();`;
 const out=humanReading(source);assert.equal(out.internals.length,0);assert.match(out.code,/application logic/);assert.match(out.code,/globalThis.result/);
});
test('numeric paths expose branches and remove arithmetic register bookkeeping',()=>{
 const source=`function ab(){var args=Array.prototype.slice.call(arguments),x=args[0],y=args[1],frame={};for(;x+y!==9;){with(frame)switch(x+y){case 1:if(flag()){log(x+2);x+=3;break;}else{x+=1;break;}case 4:return 'yes';case 2:return 'no';}}}ab(-1,2);`;
 const result=dispatcherReading(parse(source));assert.equal(result.machines.length,1);
 const m=result.machines[0];assert.equal(m.nodes.length,3);assert.match(m.pathCode,/if \(flag\(\)\)/);assert.match(m.pathCode,/log\(1\)/);assert.doesNotMatch(m.pathCode,/x \+=/);parse(m.pathCode);
});
test('cyclic and unresolved dispatchers do not receive invented structured paths',()=>{
 const cycle=`function ab(){var args=Array.prototype.slice.call(arguments),x=args[0];for(;x!==9;){with({})switch(x){case 1:log();break;}}}ab(1);`;
 const m=dispatcherReading(parse(cycle)).machines[0];assert.equal(m.nodes.length,1);assert.equal(m.pathCode,null);
 const dynamic=cycle.replace('log();break','x=next();break');assert.equal(dispatcherReading(parse(dynamic)).machines[0].pathCode,null);
});
