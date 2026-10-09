import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {advanced} from '../src/advanced.js';
import {unpack} from '../src/unpack.js';
const generate=generatorModule.default??generatorModule;
const transform=source=>{const ast=parse(source);const stats=advanced(ast,{passes:12});return {code:generate(ast).code,stats};};
function result(source){const context={atob:globalThis.atob,btoa:globalThis.btoa};try{vm.runInNewContext(source,context,{timeout:2000});return {value:JSON.stringify(context.result)};}catch(error){return {error:error.name};}}
const rc4=`function decode(text,key){var s=[],j=0,x,result='';for(var i=0;i<256;i++)s[i]=i;
  for(i=0;i<256;i++){j=(j+s[i]+key.charCodeAt(i%key.length))%256;x=s[i];s[i]=s[j];s[j]=x;}
  i=0;j=0;for(var y=0;y<text.length;y++){i=(i+1)%256;j=(j+s[i])%256;x=s[i];s[i]=s[j];s[j]=x;
  result+=String.fromCharCode(text.charCodeAt(y)^s[(s[i]+s[j])%256]);}return result;}`;
test('decodes RC4-style key schedules using owned local arrays without executing source',()=>{
 const source=rc4+`var result=decode(atob('u/MW6NlArwrT'),'Key');`;
 const out=transform(source);assert.deepEqual(result(out.code),result(source));assert.equal(out.stats.helperCalls,1);assert.match(out.code,/result = "Plaintext"/);
});
test('handles hex decoders, for-let loops, do-while loops, for-of and local array methods',()=>{
 const samples=[
  `function d(s){let out='';for(let i=0;i<s.length;i+=2){const value=parseInt(s.slice(i,i+2),16);out+=String.fromCharCode(value);}return out;}var result=d('68656c6c6f');`,
  `function d(s){const values=s.split('|');values.reverse();const out=[];for(const part of values)out.push(part.toUpperCase());return out.join('-');}var result=d('a|b|c');`,
  `function d(n){var i=0,s='';do{s+=i++;}while(i<n);return s;}var result=d(3);`,
  `function d(n){var s='';for(let i=0;i<n;i++){const value=i;s+=value;}return s;}var result=d(4);`,
  `function d(n){var result;switch(n){case 1:result='one';break;case 2:result='two';default:result+='!';}return result;}var result=d(2);`,
  `function d(a){return a.reverse().join('');}var result=d(['c','b','a']);`
 ];
 for(const source of samples){const out=transform(source);assert.deepEqual(result(out.code),result(source));assert.equal(out.stats.helperCalls,1,source);}
});
test('evaluates helper dependencies and aliases using one shared step budget',()=>{
 const source=`function run(){function inner(s){return atob(s);}const alias=inner;function middle(s){return alias(s).trim();}function outer(s){return middle(s).toUpperCase();}return outer('IGhlbGxvIA==');}var result=run();`;
 const out=transform(source);assert.deepEqual(result(out.code),result(source));assert.ok(out.stats.helperCalls>0);assert.match(out.code,/return "HELLO"/);
 const recursive=`function d(n){return e(n);}function e(n){return d(n);}var result=d(7);`;
 assert.equal(transform(recursive).stats.helperCalls,0);
});
test('folds Unicode, numeric and literal replacement encodings without changing native mutations',()=>{
 const source=`var result=[unescape('%u0068%u0069'),btoa('hi'),String.fromCodePoint(0x1f389),Number.parseInt('ff',16),Math.imul(7,9),(255).toString(16),'a-b-a'.replaceAll('a','x'),'ha'.repeat(3)];`;
 const out=transform(source);assert.deepEqual(result(out.code),result(source));assert.ok(out.stats.literalCalls>=8);
 for(const source of [
  `Object.assign(String,{fromCodePoint:()=> 'custom'});var result=String.fromCodePoint(65);`,
  `Function("String.fromCharCode=function(){return 'custom';}")();var result=String.fromCharCode(65);`,
  `const alias=Number;alias.parseInt=()=>7;var result=Number.parseInt('ff',16);`
 ])assert.deepEqual(result(transform(source).code),result(source));
});
test('retains captured-array mutation, lexical TDZ, mutable dependencies and unsupported effects',()=>{
 const samples=[
  `function run(){const a=[1,2];function d(n){a[0]=n;return a[0];}return [d(7),a];}var result=run();`,
  `function d(n){var s='';for(var i=0;i<n;i++){s+=x;const x=i;}return s;}var result=d(2);`,
  `function d(s){const a=s.split('');const alias=a;alias.push('!');return a.join('');}var result=d('hi');`,
  `function run(){var before=outer('aA==');const inner=s=>atob(s);function outer(s){return inner(s);}return before;}var result=run();`,
  `function run(){let inner=s=>atob(s);function outer(s){return inner(s);}inner=()=> 'changed';return outer('aA==');}var result=run();`,
  `function d(s){return s.replace('a',()=> 'side');}var result=d('a');`
 ];
 for(const source of samples){const out=transform(source);assert.deepEqual(result(out.code),result(source),source);}
 assert.equal(transform(samples[0]).stats.helperCalls,0);
});
test('end-to-end decoding exposes readable operations from encoded API property names',()=>{
 const source=`globalThis.result=(function(){${rc4}const property=decode(atob('u/MW6NlArwrT'),'Key');return {decoded:property};})();`;
 const out=unpack(source);assert.deepEqual(result(out.code),result(source));assert.ok(out.stats.advanced.helperCalls>=1);assert.doesNotMatch(out.code,/charCodeAt|atob\(/);
});
test('materializes fresh primitive arrays and special values without capturing shadowed undefined',()=>{
 const samples=[`function d(){return [1,-0,0/0,1/0,void 0];}function run(undefined){var a=d(),b=d();return [a!==b,Object.is(a[1],-0),Number.isNaN(a[2]),a[3]===Infinity,a[4]===void 0];}var result=run(7);`,
  `function d(){return;}function run(undefined){return d()===void 0;}var result=run(7);`];
 for(const source of samples){const out=transform(source);assert.deepEqual(result(out.code),result(source));assert.ok(out.stats.helperCalls>0);}
});
test('does not freeze a global helper dependency rewritten through a global property',()=>{
 const source=`function inner(s){return 'old';}function run(){function outer(s){return inner(s);}globalThis.inner=()=> 'new';return outer('x');}var result=run();`;
 const out=transform(source);assert.deepEqual(result(out.code),result(source));
});
