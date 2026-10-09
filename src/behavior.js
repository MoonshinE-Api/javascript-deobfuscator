import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
const traverse = traverseModule.default ?? traverseModule;
const property = node => node?.name ?? node?.value;
const families = [
  ['Network and messaging', /^(fetch|open|send|sendBeacon|postMessage|WebSocket|XMLHttpRequest)$/],
  ['Page and frames', /^(createElement|appendChild|removeChild|setAttribute|querySelector|querySelectorAll|getElementById|innerHTML|src)$/],
  ['Browser information', /^(userAgent|platform|languages|hardwareConcurrency|deviceMemory|getEntries|getEntriesByType|plugins|webdriver|screen|width|height)$/],
  ['Storage', /^(localStorage|sessionStorage|cookie|getItem|setItem|removeItem|indexedDB)$/],
  ['Events and timers', /^(addEventListener|removeEventListener|setTimeout|setInterval|requestAnimationFrame|emit|on)$/],
  ['Dynamic code', /^(eval|Function)$/]
];
const nameOf = node => t.isIdentifier(node) ? node.name : t.isThisExpression(node) ? 'this'
  : t.isMemberExpression(node) ? [nameOf(node.object), node.computed && !t.isStringLiteral(node.property) ? '[computed]' : property(node.property)].filter(Boolean).join('.')
  : t.isSequenceExpression(node) ? nameOf(node.expressions.at(-1)) : null;

// These are descriptions of syntax, not executable pseudocode or reconstructed intent.
export function describeSection(code) {
  let ast;
  try { ast = parse(code, { sourceType: 'unambiguous', allowReturnOutsideFunction: true }); }
  catch { try { ast = parse(`({${code}})`); } catch { try { ast = parse(`switch(0){${code}}`, {allowReturnOutsideFunction:true}); } catch { return []; } } }
  const steps = [], seen = new Set();
  function add(text) { if (!seen.has(text) && steps.length < 8) { steps.push(text); seen.add(text); } }
  traverse(ast, {
    IfStatement(p) { const fields = []; p.get('test').traverse({MemberExpression(r){const n=nameOf(r.node);if(n)fields.push(n);}});
      add('Checks a condition' + (fields.length ? ' involving ' + fields.slice(0,2).join(', ') : '') + ' before choosing a branch.'); },
    SwitchStatement(p) { add(`Dispatches between ${p.node.cases.length} switch stages; the selected stage controls what runs.`); },
    AssignmentExpression(p) { const name = nameOf(p.node.left); if(name) add('Updates ' + name + '.'); },
    CallExpression(p) { const name=nameOf(p.node.callee); if(!name)return;
      const arg=p.node.arguments[0]; const detail=t.isStringLiteral(arg)?` with ${JSON.stringify(arg.value.slice(0,80))}`:'';
      add('Calls ' + name + detail + '.'); },
    ReturnStatement(p) { if (p.node.argument && !t.isCallExpression(p.node.argument)) add('Returns ' + (nameOf(p.node.argument) ?? 'the computed result') + '.'); },
    ThrowStatement() { add('Throws an error on this path.'); }
  });
  return steps;
}

export function buildBehavior(source, model) {
  const ast = parse(source, { sourceType: 'unambiguous' });
  const groups = families.map(([title])=>({title, evidence:[], sections:[]}));
  const seen = new Set();
  function record(p, prop, label) {
    if(typeof prop!=='string')return;
    const line=p.node.loc?.start.line;
    for (let i=0;i<families.length;i++) if(families[i][1].test(prop)) {
      const token=i+':'+label; if(seen.has(token))return;seen.add(token);
      const section=model.cards.filter(c=>c.line<=line&&c.endLine>=line&&!c.ownerId).sort((a,b)=>a.lines-b.lines)[0];
      if(groups[i].evidence.length<6)groups[i].evidence.push({access:label,line,sectionId:section?.id??null});
      if(section&&!groups[i].sections.some(s=>s.id===section.id)&&groups[i].sections.length<4)groups[i].sections.push({id:section.id,name:section.name});
    }
  }
  traverse(ast, {MemberExpression(p){record(p,property(p.node.property),nameOf(p.node)??'[computed access]');},
    ReferencedIdentifier(p){if(!p.scope.getBinding(p.node.name))record(p,p.node.name,p.node.name);}});
  for(const card of model.cards) card.steps=describeSection(card.code);
  for(const card of model.cards) if(!card.steps.length&&card.links.length===1&&card.category==='Public API') {
    const target=model.cards.find(c=>c.id===card.links[0].id);
    if(target?.steps.length)card.steps=[`Delegates to ${target.name}.`,...target.steps.slice(0,6)];
  }
  const api=model.cards.filter(c=>c.category==='Public API');
  const journeys=api.slice(0,8).map(c=>({title:c.name,summary:c.summary,entryId:c.id,
    route:[{id:c.id,name:c.name},...c.links.slice(0,3)],steps:c.steps}));
  if(!journeys.length) for(const card of model.cards.filter(c=>!['Compiler helpers','Obfuscation scaffolding','Async state machines'].includes(c.category)).slice(0,6))
    journeys.push({title:card.name,summary:card.summary,entryId:card.id,route:[{id:card.id,name:card.name},...card.links.slice(0,3)],steps:card.steps});
  return { basis:'Static syntax evidence. Paths can be conditional, callbacks deferred, and names inferred.',
    introduction:api.length?`The main application exposes ${api.length} public entry points. Start with one task below; each opens only the functions involved.`
      :'Start with the task cards below. The access groups show where to inspect browser, storage, or dynamic-code behavior.',
    journeys,features:groups.filter(g=>g.evidence.length),events:model.events.slice(0,8),
    omittedEvents:Math.max(0,model.events.length-8)};
}

export function behaviorMarkdown(model) {
  const b=model.behavior;
  const safe=value=>String(value).replace(/[\r\n]/g,' ').replaceAll('`','\\`');
  const lines=['# What this code contains','','Read this before opening the full source.', '', b.introduction,'',b.basis,'', '## Tasks',''];
  for(const journey of b.journeys) lines.push(`- **${safe(journey.title)}**: ${safe(journey.summary)} Route: ${journey.route.map(r=>safe(r.name)).join(' → ')}.`);
  lines.push('', '## Access groups','');
  for(const feature of b.features) lines.push(`- **${feature.title}**: ${feature.evidence.map(e=>`${safe(e.access)} (L${e.line})`).join(', ')}.`);
  lines.push('', '## What to read next','', 'Open [reader.html](../reader.html): select a task, read its short steps, and expand source only when needed.',
    'A listed access proves the syntax exists, not that it always executes. Inferences are not original author comments.',
    'Input was parsed statically and not executed. Use the complete source to check inferred descriptions.', '');
  return lines.join('\n');
}
