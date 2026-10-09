import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import generatorModule from '@babel/generator';
import {annotateFunctions,functionReading,functionIndexMarkdown} from '../src/function-reading.js';
import {fullReadable} from '../src/full-readable.js';
const generate=generatorModule.default??generatorModule;
test('reading notes preserve inspected names and behavior while fragments explain enclosing bindings',()=>{
 const source=`var document={cookie:'test'};function f(){return document.cookie;}function run(){return [f(),f.name];}var result=run();`;
 const ast=parse(source),stats=annotateFunctions(ast),code=generate(ast).code;
 const a={},b={};vm.runInNewContext(source,a);vm.runInNewContext(code,b);assert.equal(JSON.stringify(a.result),JSON.stringify(b.result));assert.ok(stats.annotatedFunctions);
 const reading=functionReading(fullReadable(code).code);assert.ok(reading.functions.length);const item=reading.functions.find(item=>item.originalName==='f');assert.ok(item.captures.includes('document'));assert.equal(item.category,'Storage');
 for(const item of reading.functions)parse(item.code);assert.match(functionIndexMarkdown(reading),/Open function/);
});
test('function fragments are bounded and class methods or hostile keys do not break saved JavaScript',()=>{
 const ast=parse(`function f(a){return a['*/\\n</script>'];}class A{run(){return 3;}get value(){return this.run();}}`);annotateFunctions(ast);const code=generate(ast).code;parse(code);
 const reading=functionReading(code,{maxFunctions:1});assert.ok(reading.functions.length<=1);for(const item of reading.functions){parse(item.code);assert.doesNotMatch(item.file,/\.\.|<|>/);}
 assert.equal(functionReading(code,{maxBytes:1}).functions.length,0);
 const contextual=functionReading(`class C extends B{#value=2;method(){return ()=>{return [super.method(),this.#value];};}}`);assert.equal(contextual.functions.length,0);
});
test('expanded full layout retains encoded literal tables containing comment-like text',()=>{
 const source=`var data=${JSON.stringify(Array.from({length:32},(_,i)=>'a//b/*y'+i))};function f(x){if(x){return 1;}else{return 2;}}`;
 const full=fullReadable(source);assert.ok(full.stats.packedDataTables);assert.equal(full.stats.compactBlocks,0);assert.match(full.code,/if \(x\) \{\n/);
});
