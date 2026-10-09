import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {advanced} from '../src/advanced.js';
import {unpack} from '../src/unpack.js';
const generate=generatorModule.default??generatorModule;
function transform(source){const ast=parse(source),stats=advanced(ast,{passes:12});return {code:generate(ast).code,stats};}
function result(source){const context={atob:globalThis.atob,btoa:globalThis.btoa};vm.runInNewContext(source,context,{timeout:1000});return JSON.stringify(context.result);}

test('decodes primitive helpers with XOR loops, local arithmetic and native encoding wrappers',()=>{
  const sources=[
    `function d(s,k){var text='';for(var i=0;i<s.length;i++){text+=String.fromCharCode(s.charCodeAt(i)^k);}return text;}var result=d('obkkh',7);`,
    `function d(s){const text=atob(s);return text.slice(1).toUpperCase();}var result=d('aGVsbG8=');`,
    `var d=(a,b)=>((a^b)+3)*2;var result=d(12,7);`,
    `function d(n){var s='',i=0;while(i<n){i++;if(i===2)continue;if(i>4)break;s+=i;}return s;}var result=d(9);`,
    `function d(s){return decodeURIComponent(s).trim();}var result=d('%20hello%20');`
  ];
  for(const source of sources){const out=transform(source);assert.equal(result(out.code),result(source));assert.equal(out.stats.helperCalls,1,source);assert.doesNotMatch(out.code,/result = d\(/);}
});

test('retains helpers with effects, closure reads, TDZ, reflection, mutations and unsupported scopes',()=>{
  const sources=[
    `var log=[];function d(s){log.push(s);return s;}var result=[d('x'),log];`,
    `var key=7;function d(s){return s^key;}key=9;var result=d(12);`,
    `var result=d(3);var d=n=>n+1;`,
    `function d(n){const a=b;let b=n;return a;}var result=d(3);`,
    `function d(s){return this.text+s;}var result=d.call({text:'a'},'b');`,
    `function d(s){return arguments[0]+s;}var result=d('a');`,
    `function d(n){for(let i=0;i<n;i++){}return typeof i;}var result=d(3);`,
    `function d(s){return atob(s);}atob=function(){return 'custom';};var result=d('aA==');`,
    `var alias=String;alias.fromCharCode=()=> 'custom';function d(n){return String.fromCharCode(n);}var result=d(65);`,
    `function d(n){let s=0;{let s=n;}return s;}var result=d(3);`,
    `function d(n){return String.fromCharCode(n);}var result=d({valueOf(){return 65;}});`
  ];
  for(const source of sources){const out=transform(source);assert.equal(out.stats.helperCalls,0,source);
    const observed=s=>{try{return result(s);}catch(e){return e.name;}};assert.equal(observed(out.code),observed(source),source);}
});

test('helper interpreter stops infinite and oversized work and never executes submitted code',()=>{
  const before=performance.now();
  for(const source of [
    `function d(n){while(true)n++;return n;}var result=d(1);`,
    `function d(n){var s='x';for(var i=0;i<n;i++)s+=s;return s;}var result=d(100);`,
    `function d(n){globalThis.__helperExecuted=true;return n;}var result=d(1);`
  ]){assert.equal(transform(source).stats.helperCalls,0);}
  assert.ok(performance.now()-before<5000);assert.equal(globalThis.__helperExecuted,undefined);
});

test('full quality pipeline exposes helper strings and simplifies the conditions they hide',()=>{
  const source=`globalThis.result=(function(){function _0xabc(s,k){var r='';for(var i=0;i<s.length;i++)r+=String.fromCharCode(s.charCodeAt(i)^k);return r;}
    function _0xdef(s){return atob(s);}const _0x123={check:function(a,b){return a===b;}};
    if(_0x123.check(_0xabc('obkkh',7),_0xdef('aGVsbG8=')))return 'decoded';else return 'hidden';})();`;
  const out=unpack(source);assert.equal(result(out.code),result(source));
  assert.match(out.code,/return "decoded"/);assert.doesNotMatch(out.code,/fromCharCode|atob\(|if \(/);
  assert.ok(out.stats.advanced.helperCalls>=2);assert.ok(out.stats.advanced.deadBranches>=1);
});
test('resolves aliases and offset decoders over immutable captured tables and keys',()=>{
  const sources=[
    `function run(){const t=['language','canvas','userAgent'];function d(i){i-=100;return t[i];}const alias=d;return [alias(100),alias(102)];}var result=run();`,
    `function run(){const k=7;function d(s){var r='';for(var i=0;i<s.length;i++)r+=String.fromCharCode(s.charCodeAt(i)^k);return r;}return d('obkkh');}var result=run();`
  ];
  for(const source of sources){const out=transform(source);assert.equal(result(out.code),result(source));assert.ok(out.stats.helperCalls>0);}
  const unsafe=[
    `function run(){const t=['x'];function d(i){return t[i];}t[0]='changed';return d(0);}var result=run();`,
    `function run(){const t=['x'];function d(i){return t[i];}const alias=t;alias[0]='changed';return d(0);}var result=run();`,
    `function run(){var before=d(0);var t=['x'];function d(i){return t[i];}return before;}var result=run();`,
    `function run(){function d(i){return t[i];}return d(0);const t=['x'];}var result=run();`,
    `function run(){const t=['x'];[t[0]]=['changed'];function d(i){return t[i];}return d(0);}var result=run();`
  ];
  for(const source of unsafe){const out=transform(source);assert.equal(out.stats.helperCalls,0,source);
    const observed=s=>{try{return result(s);}catch(e){return e.name;}};assert.equal(observed(out.code),observed(source));}
});
