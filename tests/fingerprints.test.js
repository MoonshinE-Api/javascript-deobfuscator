import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import {buildFingerprints} from '../src/fingerprints.js';
import {fullReadable} from '../src/full-readable.js';
import {buildReadingModel,readerHtml} from '../src/reader.js';
import {buildBehavior} from '../src/behavior.js';
import {buildInformation} from '../src/information.js';

test('fingerprint inventory retains every recognized site and accurate source and artifact line numbers',()=>{
 const code=Array.from({length:45},(_,i)=>`navigator.userAgent; // site ${i}`).join('\n')+"\ncanvas.getContext('webgl');\ncanvas.getContext('2d');\nobject[key];\nfunction dormant(){return document.cookie;}";
 const {inventory,code:artifact}=buildFingerprints(code,null);
 assert.equal(inventory.categories.find(c=>c.id==='browser').staticSites,45);
 assert.equal(inventory.categories.find(c=>c.id==='cookies').status,'found-in-code');
 assert.equal(inventory.categories.find(c=>c.id==='location').status,'not-detected');
 assert.equal(inventory.categories.find(c=>c.id==='webgl').staticSites,1);
 assert.equal(inventory.categories.find(c=>c.id==='canvas').staticSites,1);
 assert.equal(inventory.coverage.unresolvedComputedSites,1);
 for(const finding of inventory.findings){const line=code.split('\n')[finding.source.line-1];assert.equal(finding.source.code,line);
   assert.equal(artifact.split('\n')[finding.readingFile.line-1],'  {');
 }
 parse(artifact,{sourceType:'module'});
 const ctx={};vm.runInNewContext(artifact.replaceAll('export const','const').replace('export default { findings, observations, browserObservations };','globalThis.result={findings,observations,browserObservations};'),ctx);
 assert.equal(ctx.result.findings.length,inventory.findings.length);
 assert.ok(ctx.result.findings[0].sourceLines[0].startsWith('1: navigator.userAgent'));
});
test('inventory distinguishes listener registration, writes, shadowed globals and runtime source',()=>{
 const code=`document.addEventListener('mousemove',e=>e.clientX);\ndocument.cookie='a=1';\nfunction f(navigator){return navigator.userAgent;}`;
 const trace={events:[{step:1,kind:'read',target:'navigator.userAgent',detail:'invented',source:{file:'src/trace-input.js',line:777,code:'navigator.userAgent'}}],errors:[],dropped:3};
 const {inventory}=buildFingerprints(code,trace);
 assert.ok(inventory.findings.some(f=>f.operation==='register-listener'));
 assert.equal(inventory.findings.find(f=>f.access==='document.cookie').operation,'write');
 assert.equal(inventory.findings.find(f=>f.access==='navigator.userAgent').confidence,'possible-signal-by-property-name');
 assert.equal(inventory.observations[0].source.line,777);assert.equal(inventory.coverage.traceDropped,3);
 assert.equal(inventory.categories.find(c=>c.id==='browser').status,'observed-in-simulation');
});
test('complete layout preserves control flow, closures, directives, ASI, comments and all code',()=>{
 const source=`"use strict";\nfunction make(x){\n return function(){\n return ++x;\n };\n}\nfunction multiline(){\n return\n 42;\n}\nfunction guarded(x){\n if(x){return /a/.test('a');}\n throw new Error('no');\n}\n// close </script> and a line comment\nconst counter=make(2);\nglobalThis.result=[counter(),counter(),multiline(),guarded(true)];`;
 const full=fullReadable(source);assert.equal(full.stats.compactBlocks,0);assert.match(full.code,/if \(x\) \{\n/);
 const original={},cleaned={};vm.runInNewContext(source,original);vm.runInNewContext(full.code,cleaned);
 assert.deepEqual(Array.from(cleaned.result),Array.from(original.result));assert.ok(full.code.includes('"use strict"'));
 assert.ok(full.code.includes('throw new Error'));parse(full.code);
});
test('fingerprint reader opens numbered evidence and paginates all sites without running source',()=>{
 class Element{constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';}append(n){this.children.push(n);}replaceChildren(...n){this.children=n;}get text(){return this.textContent+this.children.map(c=>c.text).join(' ');}descendants(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.descendants(tag)]);}}
 const code=Array.from({length:45},()=>`navigator.userAgent;`).join('\n')+"\nconst hostile='</script><script>evil()</script>';";
 const model=buildReadingModel(code);model.behavior=buildBehavior(code,model);model.information=buildInformation(null);model.fingerprints=buildFingerprints(code,null).inventory;
 const html=readerHtml(model);assert.equal((html.match(/<script/g)??[]).length,2);
 const script=html.match(/<\/script><script>([\s\S]*?)<\/script>/)[1];parse(script);
 const ids=Object.fromEntries(['model','content','nav','search'].map(id=>[id,new Element(id)]));ids.model.textContent=JSON.stringify(model);
 vm.runInNewContext(script,{document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag)}});
 ids.nav.descendants('button').find(b=>b.textContent==='Fingerprint inventory').onclick();
 ids.content.descendants('button').find(b=>b.textContent==='Browser and operating system').onclick();
 ids.content.descendants('button').find(b=>b.textContent==='Next 40').onclick();
 const sourceButton=ids.content.descendants('button').find(b=>b.textContent.includes('navigator.userAgent'));sourceButton.onclick();
 assert.equal(ids.content.descendants('pre')[0].textContent,'41: navigator.userAgent;');assert.ok(ids.content.text.includes('line 41'));
});
test('offline reading desk exposes static evidence without capture commands',()=>{
 const code='navigator.userAgent;';
 const model=buildReadingModel(code);model.behavior=buildBehavior(code,model);
 model.information=buildInformation(null,[{file:'src/readable.js',code}]);
 model.fingerprints=buildFingerprints(code,null).inventory;
 const html=readerHtml(model);
 assert.doesNotMatch(html,/--trace|--browser|showBrowser|Real browser observations/);
 assert.match(html,/offline static code inspection/);
 assert.equal((html.match(/<script/g)??[]).length,2);
});
