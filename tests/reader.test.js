import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { buildReadingModel, readerHtml, startHere } from '../src/reader.js';
import { buildBehavior } from '../src/behavior.js';
import {buildInformation} from '../src/information.js';

const source = `export default function clientEntry(){
  function resetHandler(){state.ready=false;}
  function showChallenge(){eventBus.emit('show');}
  function mergeObjects(e){return Object.assign(e);}
  function getConfig(){return state.config;}
  function asyncFlow(ctx){switch(ctx.prev=ctx.next){case 0:return request();case 1:return ctx.stop();}}
  var clientApi={setConfig(options){state.config=options;},getConfig,run:showChallenge,reset:resetHandler,version:'1.0'};
  eventBus.on('READY',()=>{showChallenge();});
  eventBus.on('RESET',resetHandler);
}`;

test('creates small public entry cards and scope-aware links to their handlers', () => {
  const model = buildReadingModel(source, [{id:1,dependencies:[]}]);
  const run = model.cards.find(card => card.name === 'run');
  assert.equal(run.category, 'Public API');
  assert.equal(run.links[0].name, 'showChallenge');
  assert.equal(model.events[0].handlerName, 'on READY');
  assert.equal(model.events[1].handlerId, model.cards.find(card => card.name === 'resetHandler').id);
  assert.equal(model.cards.find(card => card.name === 'mergeObjects').category, 'Compiler helpers');
  assert.equal(model.cards.filter(card => card.category === 'Public API').length, 5);
  assert.ok(model.cards.find(card => card.name === 'version').code.includes("version:'1.0'"));
  assert.ok(startHere(model).split('\n').length < 100);
  assert.ok(!run.code.includes('function mergeObjects'));
  assert.ok(run.lines < model.totalLines);
});

test('HTML embeds hostile source as inert JSON and has a parseable viewer script', () => {
  const source = `export default function clientEntry(){function f(){return '</script><script>alert(1)</script>';}}`;
  const html = readerHtml(buildReadingModel(source));
  assert.equal((html.match(/<script/g) ?? []).length, 2);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  const json = html.match(/<script type="application\/json" id="model">([\s\S]*?)<\/script>/)[1];
  assert.ok(JSON.parse(json).cards[0].code.includes('</script>'));
  const script = html.match(/<\/script><script>([\s\S]*?)<\/script>/)[1];
  parse(script, {sourceType:'script'});
  assert.ok(!script.includes('innerHTML'));
  assert.ok(!script.includes('fetch('));
});

test('scope-aware links do not mistake shadowed functions for top-level handlers', () => {
  const model = buildReadingModel(`export default function clientEntry(){function target(){} function outer(){function target(){} target();}}`);
  assert.deepEqual(model.cards.find(card => card.name === 'outer').links, []);
});

test('general programs index all top-level functions and expose compiled async stages', () => {
  const source=`function first(){return 1;} function second(c){switch(c.prev=c.next){case 0:c.next=2;return request();case 2:return c.stop();}}`;
  const model=buildReadingModel(source);
  assert.ok(model.cards.some(card=>card.name==='first'));const second=model.cards.find(card=>card.name==='second');
  assert.equal(second.stages.length,2);assert.equal(model.cards.filter(card=>card.category==='Async state machines').length,2);
  assert.equal(model.cards.find(card=>card.id===second.stages[0].id).ownerId,second.id);
});

test('reader controls navigate aliases, search, reveal helpers and display inert source', () => {
  // A minimal in-memory DOM exercises OUR viewer script, not a browser and
  // never the submitted JavaScript. Input snippets remain textContent data.
  class Element {
    constructor(tag) { this.tag=tag;this.children=[];this.textContent='';this.value='';this.checked=false;this.classes=new Set();this.classList={add:name=>this.classes.add(name)}; }
    append(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children=nodes; }
    get text() { return this.textContent+this.children.map(child=>child.text).join(' '); }
    descendants(tag) { return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.descendants(tag)]); }
  }
  const model=buildReadingModel(source), html=readerHtml(model);
  const ids=Object.fromEntries(['model','content','nav','search','helpers','subtitle','source-link','count','overview'].map(id=>[id,new Element(id)]));
  ids.model.textContent=JSON.stringify(model);
  const viewer=html.match(/<\/script><script>([\s\S]*?)<\/script>/)[1];
  const historyCalls=[];
  vm.runInNewContext(viewer, {document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag)},
    location:{hash:'',pathname:'/reader.html',search:''},history:{replaceState:(_,__,url)=>historyCalls.push(url)}});
  assert.match(ids.content.text, /5\s*public methods/);
  assert.ok(!ids.nav.text.includes('mergeObjects'));
  const runButton=ids.content.descendants('button').find(button=>button.textContent==='run');
  runButton.onclick();
  assert.ok(ids.content.text.includes('showChallenge'));
  assert.equal(ids.content.descendants('pre')[0].textContent,'run:showChallenge');
  ids.content.descendants('button').find(button=>button.textContent==='showChallenge').onclick();
  assert.ok(ids.content.descendants('pre')[0].textContent.includes("eventBus.emit('show')"));
  ids.search.value='reset';ids.search.oninput();assert.ok(ids.nav.text.includes('resetHandler'));assert.ok(!ids.nav.text.includes('showChallenge'));
  ids.search.value='';ids.helpers.checked=true;ids.helpers.onchange();assert.ok(ids.nav.text.includes('mergeObjects'));
  ids.overview.onclick();assert.ok(ids.content.text.includes('Read the behavior'));assert.equal(historyCalls.at(-1),'/reader.html');
  ids.search.value='asyncFlow';ids.search.oninput();
  ids.nav.descendants('button').find(button=>button.textContent==='asyncFlow').onclick();
  ids.content.descendants('button').find(button=>button.textContent==='Stage 0').onclick();
  assert.ok(ids.content.descendants('pre')[0].textContent.startsWith('case 0:'));
  assert.ok(ids.content.descendants('button').some(button=>button.textContent==='asyncFlow'));
});

test('task view hides unrelated functions, expands the index on request, and collapses source',()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';this.checked=false;this.classList={add(){}};}
    append(n){this.children.push(n);}replaceChildren(...n){this.children=n;}
    get text(){return this.textContent+this.children.map(c=>c.text).join(' ');}
    descendants(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.descendants(tag)]);}
  }
  const source=`function configure(){state.config=1;}function run(){state.running=true;}function unrelated(){return 1;}var api={setConfig:configure,run};`;
  const model=buildReadingModel(source);model.behavior=buildBehavior(source,model);
  const html=readerHtml(model),ids=Object.fromEntries(['model','content','nav','search','browse','helpers','subtitle','source-link','count','overview'].map(id=>[id,new Element(id)]));
  ids.model.textContent=JSON.stringify(model);
  vm.runInNewContext(html.match(/<\/script><script>([\s\S]*?)<\/script>/)[1],{document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag)},location:{hash:'',pathname:'/reader.html',search:''},history:{replaceState(){}}});
  assert.ok(ids.content.text.includes('Pick a task'));assert.ok(!ids.content.text.includes('Observed simulation'));assert.ok(!ids.nav.text.includes('unrelated'));
  ids.browse.checked=true;ids.browse.onchange();assert.ok(ids.nav.text.includes('unrelated'));
  ids.nav.descendants('button').find(b=>b.textContent==='configure').onclick();
  assert.ok(ids.content.text.includes('Steps visible'));assert.equal(ids.content.descendants('details').at(-1).open,false);
});
test('function reader filters titles and renders snippets and enclosing context as inert text',()=>{
 class Element {
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';this.checked=false;this.classList={add(){}};}
  append(n){this.children.push(n);}replaceChildren(...n){this.children=n;}setAttribute(){}
  get text(){return this.textContent+this.children.map(c=>c.text).join(' ');}
  descendants(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.descendants(tag)]);}
 }
 const source='function run(){return state.value;}';
 const model=buildReadingModel(source);model.behavior=buildBehavior(source,model);model.information=buildInformation(null);
 model.functionReading={scope:'Syntax hints',functions:[{title:'Read saved browser values',note:'Reads storage',originalName:'fn',keys:['getItem'],lines:4,line:8,captures:['state'],code:'</script><script>throw 1</script>',file:'src/functions/001-Storage.js'},{title:'Crypto helper',originalName:'other',keys:['encrypt'],lines:5,captures:[],code:'function other(){}'}]};
 const ids=Object.fromEntries(['model','content','nav','search','browse','helpers','subtitle','source-link','count','overview'].map(id=>[id,new Element(id)]));ids.model.textContent=JSON.stringify(model);
 vm.runInNewContext(readerHtml(model).match(/<\/script><script>([\s\S]*?)<\/script>/)[1],{document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag)},location:{hash:'',pathname:'/reader.html',search:''},history:{replaceState(){}}});
 ids.nav.descendants('button').find(b=>b.textContent.startsWith('Read individual functions')).onclick();
 const filter=ids.content.descendants('input')[0];filter.value='getitem';filter.oninput();
 assert.equal(ids.content.descendants('button').length,1);ids.content.descendants('button')[0].onclick();
 assert.match(ids.content.text,/Enclosing bindings: state/);assert.equal(ids.content.descendants('pre')[0].textContent,model.functionReading.functions[0].code);
 assert.equal(ids.content.descendants('a')[0].href,'src/functions/001-Storage.js');
 ids.content.descendants('button')[0].onclick();assert.equal(ids.content.descendants('button').length,2);
});
test('human reading and dispatcher controls render source as inert text',()=>{
 class Element {
  constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.value='';this.checked=false;this.classList={add(){}};}
  append(n){this.children.push(n);}replaceChildren(...n){this.children=n;}setAttribute(){}
  get text(){return this.textContent+this.children.map(c=>c.text).join(' ');}
  descendants(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.descendants(tag)]);}
 }
 const model=buildReadingModel('function run(){return 1;}');model.behavior=buildBehavior('',model);model.information=buildInformation(null);
 const hostile='</script><script>throw 1</script>';
 model.humanReading={file:'src/human-reading.js',scope:'Reading projection',code:hostile,stats:{literalCandidates:1,directProperties:1,renamedFunctions:1},functions:[{name:'readStorage',title:'Storage helper',category:'Storage',keys:['getItem'],line:1,endLine:1,note:'Reading clue'}],dispatchers:{scope:'Candidate paths',machines:[{name:'stateDispatcher',line:3,nodes:[],unresolved:[],pathCode:hostile,pathFile:'src/reading-paths/001.js'}]}};
 const ids=Object.fromEntries(['model','content','nav','search','browse','helpers','subtitle','source-link','count','overview'].map(id=>[id,new Element(id)]));ids.model.textContent=JSON.stringify(model);
 const html=readerHtml(model);assert.equal((html.match(/<script/g)??[]).length,2);
 vm.runInNewContext(html.match(/<\/script><script>([\s\S]*?)<\/script>/)[1],{document:{getElementById:id=>ids[id],createElement:tag=>new Element(tag)},location:{hash:'',pathname:'/reader.html',search:''},history:{replaceState(){}}});
 ids.nav.descendants('button').find(b=>b.textContent==='Human reading functions').onclick();
 const filter=ids.content.descendants('input')[0];filter.value='getitem';filter.oninput();ids.content.descendants('button')[0].onclick();assert.equal(ids.content.descendants('pre')[0].textContent,hostile);
 ids.nav.descendants('button').find(b=>b.textContent==='Dispatcher paths').onclick();assert.equal(ids.content.descendants('pre')[0].textContent,hostile);
});
