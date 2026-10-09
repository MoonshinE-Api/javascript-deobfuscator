import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildReadingModel,readerHtml} from '../src/reader.js';
import {buildBehavior,behaviorMarkdown} from '../src/behavior.js';

test('behavior overview connects access evidence to compact tasks and short steps',()=>{
  const source=`function boot(){const frame=document.createElement('iframe');frame.src='/frame';navigator.userAgent;}
  function send(){if(state.ready){fetch('/submit');}localStorage.setItem('flag','1');}function padding(){}
  var api={setConfig:boot,run:send};`;
  const model=buildReadingModel(source);model.behavior=buildBehavior(source,model);
  assert.equal(model.behavior.journeys.length,2);
  assert.ok(model.behavior.features.find(f=>f.title==='Network and messaging').sections.some(s=>s.name==='send'));
  const send=model.cards.find(c=>c.name==='send');assert.ok(send.steps.some(s=>s.includes('Checks a condition')));assert.ok(send.steps.some(s=>s.includes('fetch')));
  assert.ok(model.cards.every(c=>c.steps.length<=8));assert.ok(behaviorMarkdown(model).split('\n').length<45);
  const html=readerHtml(model);assert.ok(html.includes('Pick a task'));assert.ok(html.includes('d.open=false'));
  const ids=new Set(model.cards.map(c=>c.id));for(const f of model.behavior.features)for(const e of f.evidence)if(e.sectionId)assert.ok(ids.has(e.sectionId));
});
