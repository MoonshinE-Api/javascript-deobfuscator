import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import {shrink} from '../src/shrink.js';
import {unpack} from '../src/unpack.js';
import {fullReadable} from '../src/full-readable.js';
import {shortGuide} from '../src/short-guide.js';
import {buildReadingModel,readerHtml} from '../src/reader.js';
import {buildBehavior} from '../src/behavior.js';
import {buildInformation} from '../src/information.js';

function executeTrusted(source){const context={};try{vm.runInNewContext(source,context,{timeout:1000});return {result:JSON.stringify(context.result),error:null};}catch(error){return {result:JSON.stringify(context.result),error:error.name};}}
function equivalent(source){const result=shrink(source,{rounds:12});assert.deepEqual(executeTrusted(result.code),executeTrusted(source));parse(result.code);return result;}

test('removes safe unused aliases and empty scopes while retaining TDZ, lexical shadows and directives',()=>{
 for(const source of [
  `function run(){const original=8;const unused=original;{ {var x=3;globalThis.result=x;} }}run();`,
  `const original=8;class Example{read(){const unused=original;return 9;}}globalThis.result=new Example().read();`,
  `function run(){const unused=later;let later=9;return 3;}globalThis.result=run();`,
  `function run(){let value=2;{let value=8;globalThis.result=value;}return value;}globalThis.result=[run(),globalThis.result];`,
  `function run(){{'use strict';}return this===undefined;}globalThis.result=run();`,
  `function run(){label:{ {break label;} }return 3;}globalThis.result=run();`
 ])equivalent(source);
 assert.ok(equivalent(`function run(){const original=8;const unused=original;return original;}globalThis.result=run();`).stats.removedBindings>0);
});

test('ten thousand junk statements become a short complete program with the same trusted result',()=>{
 const source='globalThis.result=(function(){\n'+Array.from({length:10000},(_,i)=>`var junk${i}=[${i}, {unused: true}];`).join('\n')+'\nfunction add(a,b){return a+b;} var written=0;written=9;function unused(){return 2;}return add(20,22);throw new Error("unreachable");})();';
 const result=equivalent(source);assert.ok(result.code.split('\n').length<25);assert.equal(result.stats.removedBindings,10001);assert.ok(result.stats.foldedHelperCalls>=1);assert.ok(result.stats.removedFunctions>=2);assert.equal(result.stats.removedDeadWrites,1);assert.ok(result.stats.removedUnreachable>0);
});
test('scope-specific eval protection keeps visible bindings and cleans unrelated functions',()=>{
 const source='function sensitive(){var secret=8;return eval("secret");}function clean(){var rubbish=[1,2];return 3;}globalThis.result=[sensitive(),clean()];';
 const out=equivalent(source);assert.match(out.code,/secret/);assert.doesNotMatch(out.code,/rubbish/);assert.equal(out.stats.removedBindings,1);
 equivalent('function sensitive(){var hidden=7;with({x:1}){return hidden+x;}}globalThis.result=sensitive();');
});
test('globals, lexical TDZ, constant assignment errors and hoisting remain observable',()=>{
 const samples=[
  'var globalUnused=7;globalThis.result=globalThis.globalUnused;',
  'function f(){return later;let later=7;}globalThis.result=f();',
  'function f(){return ()=>later;let later=7;}globalThis.result=f()();',
  'function f(){x=7;let x=8;}globalThis.result=f();',
  'function f(){const x=1;x=2;return 3;}globalThis.result=f();',
  'function f(){return typeof x;var x=1;}globalThis.result=f();',
  'function f(){return typeof local;function local(){return 3;}}globalThis.result=f();',
  'function f(){if(true){function inner(){return 4;}}return inner();}globalThis.result=f();'
 ];for(const source of samples)equivalent(source);
 assert.match(shrink('var retained=1;').code,/retained/);
 assert.match(shrink('42;').code,/42/);
});
test('getters, spreads, calls, coercion and unsupported VM loops keep their effects',()=>{
 const source='globalThis.result=[];function run(){var a=unknown();var b={[(result.push("key"),"x")]:1};var c={...{get x(){result.push("getter");return 1;}}};var d=( {valueOf(){result.push("coercion");return 1;}})+2;var e=/regex/;for(var i=0;i<2;i++){result.push(i);}return a;}function unknown(){result.push("call");return 5;}run();';
 const out=equivalent(source);assert.match(out.code,/valueOf/);assert.match(out.code,/getter/);assert.match(out.code,/for/);assert.match(out.code,/\/regex\//);
});
test('dead local writes cascade while helper mutation, defaults and arguments are retained',()=>{
 const a=equivalent('globalThis.result=(function(){var x=1;var dead=()=>x;x=2;return 4;})();');assert.ok(a.stats.removedBindings>=2);
 for(const source of [
  'globalThis.result=(function(){function h(a=3){return a+1;}return h();})();',
  'globalThis.result=(function(){function h(a){return arguments[0]+1;}return h(3);})();',
  'globalThis.result=(function(){function h(a){return a+1;}h=a=>a+2;return h(3);})();',
  'globalThis.result=(function(){var h=a=>a+1;return h(4);})();',
  'globalThis.result=(function(){let {x}={get x(){return 9;}};return x;})();',
  'globalThis.result=(function(){var x=0;for(var a=0;a<2;a++){x++;}return x;})();'
 ])equivalent(source);
 const output=shrink('function f(){async function asyncHelper(a){return a+1;}function* generator(a){return a+1;}return [asyncHelper(3),generator(4)];}');assert.equal(output.stats.foldedHelperCalls,0);
});
test('standalone default pipeline removes local junk and records its reduction',()=>{
 const source='globalThis.result=(function(){'+Array.from({length:1000},(_,i)=>`var junk${i}=[1,2];`).join('\n')+'return 42;})();';
 const result=unpack(source);assert.equal(executeTrusted(result.code).result,'42');assert.ok(result.stats.shrink.removedBindings>=1000);assert.ok(result.stats.originalFormattedLines>1000);assert.ok(result.code.split('\n').length<20);
});
test('literal tables use bounded readable rows and preserve exact values and comments',()=>{
 const source='globalThis.result=[\n'+Array.from({length:1000},(_,i)=>JSON.stringify('entry-'+i)).join(',\n')+'\n];';
 const out=fullReadable(source);assert.ok(out.stats.outputLines<160);assert.equal(out.stats.packedDataTables,1);assert.deepEqual(executeTrusted(out.code),executeTrusted(source));assert.ok(out.code.split('\n').every(line=>line.length<=120));
 const commented=fullReadable('globalThis.result=[1,2,3,4,5,6,7,/* keep me */8,9];');assert.match(commented.code,/keep me/);assert.equal(commented.stats.packedDataTables,0);
 const holes=fullReadable('globalThis.result=[1,,2,3,4,5,6,7,8,9];');assert.equal(holes.stats.packedDataTables,0);assert.deepEqual(executeTrusted(holes.code),executeTrusted('globalThis.result=[1,,2,3,4,5,6,7,8,9];'));
});
test('short guide is inert, bounded and points to exact complete-source calls',()=>{
 const source=Array.from({length:200},(_,i)=>`fetch('https://example.invalid/${i}');`).join('\n');const guide=shortGuide(source);
 parse(guide.code,{sourceType:'module'});assert.equal(guide.model.sites.length,160);assert.ok(guide.model.lines<1000);
 const context={};vm.runInNewContext(guide.code.replace('export const operations','globalThis.operations'),context);assert.equal(context.operations.length,160);
 for(const site of guide.model.sites){assert.equal(source.split('\n')[site.line-1].slice(site.column-1).startsWith('fetch('),true);assert.match(site.action,/server/);}
});
test('friendly overview navigates to exact source while hostile snippets remain inert text',()=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';}append(n){this.children.push(n);}replaceChildren(...n){this.children=n;}get text(){return this.textContent+this.children.map(c=>c.text).join(' ');}descendants(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.descendants(tag)]);}}
 const source='fetch("</script><script>evil()</script>");';const model=buildReadingModel(source);model.behavior=buildBehavior(source,model);model.information=buildInformation(null);model.shortReading=shortGuide(source).model;model.reduction={originalLines:10000,fullLines:100};
 const html=readerHtml(model);assert.equal((html.match(/<script/g)??[]).length,2);
 const ids=Object.fromEntries(['model','content','nav','search'].map(id=>[id,new Element(id)]));ids.model.textContent=JSON.stringify(model);
 vm.runInNewContext(html.match(/<\/script><script>([\s\S]*?)<\/script>/)[1],{document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag)}});
 ids.nav.descendants('button').find(b=>b.textContent==='Short code overview').onclick();assert.match(ids.content.text,/10000 formatted lines/);
 ids.content.descendants('button').find(b=>b.textContent.includes('server')).onclick();assert.match(ids.content.text,/line 1/);assert.match(ids.content.descendants('pre')[0].textContent,/evil/);
 assert.equal(ids.content.descendants('a')[0].href,'src/full-human-readable.js');
});
