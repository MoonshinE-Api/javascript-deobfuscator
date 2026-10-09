import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {noviceReaderHtml} from './novice-reader.js';
const traverse = traverseModule.default ?? traverseModule;
const key = node => node?.name ?? node?.value;
const words = name => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_$]/g, ' ').replace(/\d+$/, '').toLowerCase();
const opaque = name => /^[_$]*[A-Za-z]{1,3}\d*$/.test(name);

function inspect(p) {
  const calls = new Set(), reads = new Set(), writes = new Set(), strings = new Set(), properties = new Set();
  const callPaths = [];
  const label = node => {
    if (t.isIdentifier(node)) return node.name;
    if (t.isThisExpression(node)) return 'this';
    if (t.isMemberExpression(node) && !node.computed) {
      const base = label(node.object); return base ? base + '.' + key(node.property) : null;
    }
    if (t.isSequenceExpression(node)) return label(node.expressions.at(-1));
    return null;
  };
  // Include nested callbacks: they are part of the function shown in the card.
  p.traverse({
    CallExpression(ref) { const name = label(ref.node.callee); if (name) calls.add(name); callPaths.push(ref); },
    MemberExpression(ref) { if (!ref.node.computed) properties.add(key(ref.node.property));
      const name = label(ref.node); if (name) reads.add(name); },
    AssignmentExpression(ref) { const name = label(ref.node.left); if (name) writes.add(name); },
    UpdateExpression(ref) { const name = label(ref.node.argument); if (name) writes.add(name); },
    StringLiteral(ref) { strings.add(ref.node.value); }
  });
  return { calls: [...calls], reads: [...reads], writes: [...writes], strings, properties, callPaths };
}

function group(name, info, node) {
  if (/^(defineClass|assertClass|toPrimitive|toPropertyKey|typeOf|getValueType|defineDataProperty|mergeObjects|omitProperties|cloneValue|copyArrayPrefix|getOwnPropertyKeys|toDestructuredArray|advanceAsyncGenerator)/.test(name)) return 'Compiler helpers';
  if ((info.strings.size > 15 && node.params.length === 0 && [...info.strings].some(value => /^\d+[A-Za-z]+$/.test(value)))
    || info.strings.has('(((.+)+)+)+$')) return 'Obfuscation scaffolding';
  if (/interaction|pointer|touch|keyboard|metrics|timing|performance|error|session/i.test(name)
    || info.properties.has('btoa') || info.properties.has('getEntries')) return 'Events and telemetry';
  if (/container|frame|element|className|css|styling/i.test(name)
    || info.properties.has('setAttribute') || info.properties.has('createElement')) return 'UI and frames';
  return 'Application';
}

function summary(name, info) {
  const { properties: props, strings, calls, writes } = info;
  if (name === 'showChallenge') return 'Marks the challenge active and emits the event that requests it to be shown.';
  if (name === 'dispatchCallback') return 'Looks up the configured callback for an event and invokes it with the supplied arguments.';
  if (/resetHandler/.test(name)) return 'Resets challenge state, removes listeners, and refreshes the challenge container.';
  if (/applyClientConfig/.test(name)) return 'Applies configuration, updates metrics, and starts or refreshes the challenge container.';
  if (/createChallengeState/.test(name)) return 'Creates the object that tracks configuration, readiness, visibility, and challenge results.';
  if (props.has('getOwnPropertySymbols') && props.has('enumerable') && !props.has('defineProperties')) return 'Collects own property keys, including symbols, optionally filtering for enumerable properties.';
  if (/mergeObjects/.test(name)) return 'Compiler helper that copies properties and descriptors from source objects into a target.';
  if (props.has('currentScript')) return 'Finds the current client script and reads its metadata or callback configuration.';
  if (props.has('btoa') && props.has('join')) return 'Serializes buffered interaction records and encodes the result as base64.';
  if (strings.has('aria-hidden') && props.has('setAttribute')) return 'Sets the accessibility visibility attribute on the supplied element.';
  if (props.has('code') && (strings.has('Escape') || props.has('Escape')) && (strings.has('Backspace') || props.has('Backspace'))) return 'Creates a callback that records keyboard events using a key-code lookup.';
  if (props.has('touches') && props.has('floor')) return 'Creates a callback that stores touch coordinates and event timestamps.';
  if (props.has('pageX') && props.has('sqrt')) return 'Creates a callback that records pointer coordinates and calculates movement distance.';
  if (props.has('documentMode') && props.has('onError')) return 'Checks older browser support and reports an error when the browser is unsupported.';
  if (props.has('default') && props.has('optional') && props.has('hasOwnProperty')) return 'Builds settings from provided values and defaults, respecting optional fields.';
  if (props.has('done') && props.has('resolve') && props.has('value')) return 'Advances an async generator and resolves or rejects its yielded result.';
  if (props.has('getEntries')) return 'Reads browser performance entries and assembles resource timing information.';
  if (strings.has('file://') && strings.has('*')) return 'Normalizes empty, null, or file origins to a wildcard message origin.';
  if (/^setConfig$/.test(name)) return 'Public configuration method. Checks or passes the supplied options to the configuration handler.';
  if (/^getConfig$/.test(name)) return 'Returns the current configuration through the client configuration accessor.';
  if (/^run$/.test(name)) return 'Public method that delegates to the challenge display routine.';
  if (/^reset$/.test(name)) return 'Public method that delegates to the challenge reset routine.';
  if (/^version$/.test(name)) return 'Public version value exposed by the client API.';
  if (!opaque(name)) return 'Inferred role: ' + words(name) + '.' + (calls.length ? ' Calls ' + calls.slice(0, 3).join(', ') + '.' : '');
  if (writes.length) return 'Updates ' + writes.slice(0, 3).join(', ') + (calls.length ? '; calls ' + calls.slice(0, 3).join(', ') : '') + '.';
  if (calls.length) return 'Calls ' + calls.slice(0, 4).join(', ') + '. Its broader purpose is uncertain.';
  return 'A utility or value-returning function whose broader purpose is uncertain. Inspect its code for details.';
}

export function buildReadingModel(application, modules = []) {
  const source = application ?? modules[0]?.code ?? '';
  if (!source) return { sourceFile: 'src/application.js', totalLines: 0, cards: [], events: [], modules: [], topLevelLines: 0 };
  const ast = parse(source, { sourceType: 'unambiguous' });
  let root, program;
  traverse(ast, { Program(p) { program = p; }, Function(p) {
    if (p.node.id?.name === 'clientEntry' && p.parentPath.isExportDefaultDeclaration()) root = p;
  } });
  root ??= program;
  const cards = [], nodes = new Map(), bindingCards = new Map(), events = [];
  function add(p, name, category) {
    if (nodes.has(p.node)) return nodes.get(p.node);
    const info = inspect(p);
    info.aliasBinding = p.isObjectProperty() && t.isIdentifier(p.node.value) ? p.scope.getBinding(p.node.value.name) : null;
    const start = p.node.loc.start.line, end = p.node.loc.end.line;
    const card = { id: 'section-' + (cards.length + 1), name, category: category ?? group(name, info, p.node),
      line: start, endLine: end, lines: end - start + 1, parameters: p.node.params?.map(param => source.slice(param.start, param.end)) ?? [],
      summary: summary(name, info), calls: info.calls.slice(0, 14), writes: info.writes.slice(0, 14),
      code: source.slice(p.node.start, p.node.end), links: [], info };
    cards.push(card); nodes.set(p.node, card);
    const binding = p.isFunctionDeclaration() ? p.parentPath.scope.getBinding(p.node.id?.name)
      : p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parentPath.node.id) ? p.parentPath.scope.getBinding(p.parentPath.node.id.name) : null;
    if (binding) bindingCards.set(binding, card);
    return card;
  }
  if (root) root.traverse({
    Function(p) {
      const parent = p.getFunctionParent();
      if (root.isProgram()) {
        if (parent && !(parent.parentPath.isCallExpression() && parent.parentPath.node.callee === parent.node && !parent.getFunctionParent())) return;
      } else if (parent !== root) return;
      const name = p.isFunctionDeclaration() ? p.node.id?.name : p.parentPath.isVariableDeclarator() ? key(p.parentPath.node.id) : p.node.id?.name;
      if (name) add(p, name);
    },
    ObjectExpression(p) {
      const props = p.get('properties');
      if (!props.some(prop => key(prop.node.key) === 'setConfig') || !props.some(prop => key(prop.node.key) === 'run')) return;
      for (const prop of props) {
        const fn = prop.isObjectMethod() ? prop : prop.isObjectProperty() ? prop.get('value') : null;
        if (fn?.isFunction()) add(fn, String(key(prop.node.key)), 'Public API');
        else if (prop.isObjectProperty()) add(prop, String(key(prop.node.key)), 'Public API');
      }
    },
    CallExpression(p) {
      const callee = p.node.callee;
      if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.object)
        || !/eventBus/.test(callee.object.name) || key(callee.property) !== 'on') return;
      const eventNode = p.node.arguments[0];
      const event = t.isStringLiteral(eventNode) ? eventNode.value : t.isIdentifier(eventNode) ? eventNode.name : 'computed event';
      const callback = p.get('arguments.1');
      let handler;
      if (callback?.isFunction()) handler = add(callback, 'on ' + event, 'Event subscriptions');
      events.push({ event, handlerName: t.isIdentifier(callback?.node) ? callback.node.name : handler?.name ?? 'inline callback',
        handlerId: handler?.id ?? null, line: p.node.loc.start.line,
        binding: t.isIdentifier(callback?.node) ? callback.scope.getBinding(callback.node.name) : null });
    },
    SwitchStatement(p) {
      const d = p.node.discriminant;
      if (!t.isAssignmentExpression(d) || !t.isMemberExpression(d.left) || !t.isMemberExpression(d.right)
        || key(d.left.property) !== 'prev' || key(d.right.property) !== 'next'
        || !t.isIdentifier(d.left.object) || !t.isIdentifier(d.right.object, { name: d.left.object.name })) return;
      const ownerPath = p.findParent(parent => nodes.has(parent.node));
      const owner = ownerPath && nodes.get(ownerPath.node);
      for (const casePath of p.get('cases')) {
        const label = t.isStringLiteral(casePath.node.test) || t.isNumericLiteral(casePath.node.test) ? String(casePath.node.test.value) : 'default';
        const card = add(casePath, (owner?.name ?? 'async function') + ' · stage ' + label, 'Async state machines');
        card.summary = 'Compiled async stage ' + label + '. ' + card.summary;
        if (owner) { (owner.stages ??= []).push({ id: card.id, name: 'Stage ' + label }); card.ownerId = owner.id; }
      }
    }
  });
  for (const card of cards) {
    const alias = bindingCards.get(card.info.aliasBinding);
    if (alias && alias !== card) card.links.push({ id: alias.id, name: alias.name });
    for (const call of card.info.callPaths) {
      if (!t.isIdentifier(call.node.callee)) continue;
      const target = bindingCards.get(call.scope.getBinding(call.node.callee.name));
      if (target && target !== card && !card.links.some(link => link.id === target.id)) card.links.push({ id: target.id, name: target.name });
    }
    delete card.info;
  }
  // Short lookup decoders depend directly on the retained string factories.
  for (const card of cards) if (opaque(card.name) && card.lines <= 20 && card.links.some(link =>
    cards.find(target => target.id === link.id)?.category === 'Obfuscation scaffolding')) card.category = 'Obfuscation scaffolding';
  for (const event of events) { event.handlerId ??= bindingCards.get(event.binding)?.id ?? null; delete event.binding; }
  const covered = new Set();
  for (const card of cards.filter(card => !['Public API', 'Event subscriptions'].includes(card.category)))
    for (let line = card.line; line <= card.endLine; line++) covered.add(line);
  const totalLines = source.split('\n').length;
  return { sourceFile: application ? 'src/application.js' : `src/modules/${modules[0].id}.js`, totalLines,
    topLevelLines: Math.max(0, totalLines - covered.size), cards, events,
    modules: modules.map(({ id, dependencies }) => ({ id, dependencies })) };
}

export function startHere(model) {
    const lines = ['# Start here', '', 'Open [reader.html](../reader.html) for the task overview. Choose one task before expanding source. The short text version is [BEHAVIOR.md](BEHAVIOR.md).', '',
      ...(model.humanReading?['For clearer code, choose **Human reading functions** or open [human-reading.js](../src/human-reading.js). This is an analysis projection with decoded candidates and inferred names; use the complete program to check behavior. Choose **Dispatcher paths** for numeric state maps and structured candidate paths.','']:[]),
      ...(model.shortReading?['Choose **Short code overview** for plain-language operations with exact source lines. The small [short-human-readable.js](../src/short-human-readable.js) guide is an index; [full-human-readable.js](../src/full-human-readable.js) is the complete program.','']:[]),
    `The application has ${model.totalLines.toLocaleString('en-US')} lines, organized into ${model.cards.length} reading sections.`,
    'Names and explanations are inferred by local JavaScript rules. No model, server, API key, or internet connection is used.', '',
    '## Quick route', '', '1. Read the public API cards for the entry points.', '2. Follow the linked functions from each card to see what happens next.',
    '3. Use event subscriptions to find the handlers that respond later.', '4. Follow async stage buttons to inspect compiled state machines.', '5. Show helpers when you need compiler or obfuscation details.', '',
    'The reader is a navigation view; it does not execute the input or delete logic. Initialization, constants, and shared variables remain in the full source.', '',
    '## Public API', '', '| Method | What it does (inferred) | Next functions |', '| --- | --- | --- |'];
  for (const card of model.cards.filter(card => card.category === 'Public API'))
    lines.push(`| ${card.name} | ${card.summary.replaceAll('|', '\\|')} | ${card.links.map(link => link.name).join(', ')} |`);
  lines.push('', '## Useful application sections', '');
  const preferred = ['applyClientConfig', 'createChallengeState', 'showChallenge', 'resetHandler', 'mountChallengeContainer', 'updateChallengeFrame', 'dispatchCallback', 'handleReadyEvent', 'serializeInteractionEvents'];
  for (const name of preferred) {
    const card = model.cards.find(card => card.name === name);
    if (card) lines.push(`- **${name}** (line ${card.line}): ${card.summary}`);
  }
  lines.push('', '## Files', '', '- `BEHAVIOR.md`: short task and access overview.', '- `reader.html`: short steps, searchable source, calls, writes, and event handlers.',
      '- `FINGERPRINTS.md` / `fingerprints.json`: all recognized fingerprint sites, observed events and unknowns.',
      '- `../src/fingerprint-collection.js`: inert line-numbered evidence excerpts.',
        '- `../src/full-human-readable.js`: complete cleaned program with expanded statements.',
        ...(model.humanReading?['- `HUMAN_READING.md` / `HUMAN_READING.json`: candidate literals, inferred names and external data locations.','- `DISPATCHERS.md` / `DISPATCHERS.json`: supported candidate numeric paths and explicit unresolved transitions.']:[]),
        ...(model.shortReading?['- `../src/short-human-readable.js`: inert short operation guide with complete-source line references.']:[]),
    '- `../src/application.js`: main client excerpt, including shared state and initialization.', '- `../src/readable.js`: complete transformed bundle.',
    '- `../src/formatted.js`: earlier conservative formatting pass.', '- `CODE_MAP.md`: index with source line references.',
    '- `report.json`: inferred names and their evidence.', '', 'The full files are still needed for context. Extracted functions depend on closures and the bundle runtime.');
  return lines.join('\n') + '\n';
}

export function readerHtml(model) {
  if(model.information)return noviceReaderHtml(model);
  // Escape HTML script delimiters even if the input contains hostile strings.
  const data = JSON.stringify(model).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JavaScript reading desk</title><style>
:root{color-scheme:dark;--bg:#10141c;--panel:#181e28;--line:#2c3544;--text:#e3eaf4;--muted:#a5b2c5;--accent:#83dcc7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,sans-serif}header{padding:24px 30px;border-bottom:1px solid var(--line)}h1{font-size:24px;margin:0}p{margin:8px 0;color:var(--muted)}a{color:var(--accent)}main{display:grid;grid-template-columns:320px minmax(0,1fr);height:calc(100vh - 144px);min-height:500px}aside{padding:20px;border-right:1px solid var(--line);overflow:auto}input{width:100%;padding:12px;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px}input[type=checkbox]{width:auto}label{display:block;margin:14px 0;font-size:13px;color:var(--muted)}button{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:7px 12px;cursor:pointer}button:hover,button.active{border-color:var(--accent);color:var(--accent)}nav details{margin:14px 0}nav summary{color:var(--muted);cursor:pointer;font-size:12px;text-transform:uppercase;letter-spacing:1px}nav button{display:block;width:100%;text-align:left;margin:6px 0;font-size:13px;overflow-wrap:anywhere}nav small{display:block;color:var(--muted)}article{padding:28px 36px;overflow:auto;min-width:0}article h2{font-size:26px;overflow-wrap:anywhere;margin:0 0 10px}.eyebrow{font-size:12px;letter-spacing:1px;color:var(--accent);text-transform:uppercase}.tag{display:inline-block;padding:4px 9px;margin:4px 5px 4px 0;background:var(--panel);border-radius:5px;font:12px ui-monospace,monospace;overflow-wrap:anywhere}.links button{margin:4px 6px 4px 0}pre{padding:20px;background:#0b0f16;border:1px solid var(--line);border-radius:10px;overflow:auto;font:13px/1.65 Consolas,ui-monospace,monospace;tab-size:2;white-space:pre}article details{margin-top:24px}article summary{cursor:pointer}h3{font-size:15px;margin:24px 0 7px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.box{border:1px solid var(--line);border-radius:9px;padding:18px}.box strong{display:block;font-size:23px}.empty{padding:20px;color:var(--muted)}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media(max-width:760px){main{display:block;height:auto}aside{border-right:0;border-bottom:1px solid var(--line);max-height:350px}article{padding:24px}header{padding:20px}}
</style></head><body><header><h1>JavaScript reading desk</h1><p id="subtitle"></p><a id="source-link">Full application source</a> · <a href="reports/START_HERE.md">Quick guide</a></header>
<main><aside><input id="search" type="search" placeholder="Search names, events, or code" aria-label="Search reading sections"><label><input id="browse" type="checkbox"> Browse all sections</label><label><input id="helpers" type="checkbox"> Show compiler and obfuscation helpers</label><button id="overview">Overview</button><p id="count"></p><nav id="nav" aria-label="Reading sections"></nav></aside><article id="content" aria-live="polite"></article></main>
<script type="application/json" id="model">${data}</script><script>
const model=JSON.parse(document.getElementById('model').textContent);
const byId=new Map(model.cards.map(c=>[c.id,c]));
const el=(tag,text,parent)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(parent)parent.append(n);return n};
const content=document.getElementById('content'),nav=document.getElementById('nav'),search=document.getElementById('search'),helpers=document.getElementById('helpers');
const browse=document.getElementById('browse');
const recommended=new Set((model.behavior?.journeys??[]).flatMap(j=>j.route.map(r=>r.id)));
let selected=null;
document.getElementById('subtitle').textContent=model.totalLines.toLocaleString()+' lines → a short task overview. Explanations inferred locally'+'; input was not executed.';
document.getElementById('source-link').href=model.sourceFile;
const helper=c=>['Compiler helpers','Obfuscation scaffolding'].includes(c.category);
function link(card,parent){const b=el('button',card.name,parent);b.onclick=()=>show(card.id);return b;}
function renderNav(){nav.replaceChildren();const q=search.value.trim().toLowerCase();const filtered=model.cards.filter(c=>(helpers.checked||!helper(c))&&(!model.behavior||q||browse?.checked||helpers.checked||c.id===selected||recommended.has(c.id)||c.category==='Public API')&&(!q||(c.name+' '+c.summary+' '+c.code).toLowerCase().includes(q)));
document.getElementById('count').textContent=filtered.length+' sections'+(helpers.checked?'':' · helpers hidden');
const order=['Public API','Application','UI and frames','Events and telemetry','Event subscriptions','Async state machines','Compiler helpers','Obfuscation scaffolding'];
for(const category of order){const cards=filtered.filter(c=>c.category===category);if(!cards.length)continue;const d=el('details',undefined,nav);d.open=!!q||['Public API','Application'].includes(category);el('summary',category+' ('+cards.length+')',d);for(const card of cards){const b=link(card,d);if(card.id===selected)b.classList.add('active');el('small',card.lines+' lines · L'+card.line,b);}}
if(!filtered.length)el('p','No matching sections.',nav);
}
function tags(title,values){if(!values.length)return;el('h3',title,content);const box=el('div',undefined,content);for(const value of values)el('span',value,box).className='tag';}
function show(id){const card=byId.get(id);if(!card)return;selected=id;if(helper(card))helpers.checked=true;history.replaceState(null,'','#'+id);content.replaceChildren();el('div',card.category+' · lines '+card.line+'–'+card.endLine,content).className='eyebrow';el('h2',card.name,content);el('p',card.summary,content);el('p','Static inference — use the source below to verify the details.',content);
tags('Parameters',card.parameters);if(card.links.length){el('h3','Follow the next functions',content);const links=el('div',undefined,content);links.className='links';for(const target of card.links)link(byId.get(target.id),links);}
if(card.steps?.length){el('h3','Steps visible in this section',content);const list=el('ol',undefined,content);for(const step of card.steps)el('li',step,list);el('p','These describe syntax, including conditional branches and nested callbacks; they are not an unconditional execution timeline.',content);}
if(card.stages&&card.stages.length){el('h3','Compiled async stages',content);const stages=el('div',undefined,content);stages.className='links';for(const stage of card.stages){const button=link(byId.get(stage.id),stages);button.textContent=stage.name;}}
if(card.ownerId){el('h3','Containing function',content);link(byId.get(card.ownerId),content);}
tags('Calls',card.calls);tags('Assignments',card.writes);
const d=el('details',undefined,content);d.open=false;el('summary','Expand source code · '+card.lines+' lines',d);el('pre',card.code,d);
renderNav();content.scrollTop=0;}
function overview(){selected=null;history.replaceState(null,'',location.pathname+location.search);content.replaceChildren();el('div','START HERE',content).className='eyebrow';el('h2','Read the behavior one piece at a time.',content);el('p','Start with a public method. Follow its function links, then inspect the events that update state later. Search also checks the source inside each section.',content);
const grid=el('div',undefined,content);grid.className='grid';for(const [value,label] of [[model.cards.filter(c=>c.category==='Public API').length,'public methods'],[model.events.length,'event subscriptions'],[model.cards.filter(helper).length,'helper sections hidden by default']]){const box=el('div',undefined,grid);box.className='box';el('strong',String(value),box);el('span',label,box);}
el('h3','Public entry points',content);const links=el('div',undefined,content);links.className='links';for(const card of model.cards.filter(c=>c.category==='Public API'))link(card,links);
if(model.behavior){el('p',model.behavior.introduction,content);el('h3','Pick a task',content);const tasks=el('div',undefined,content);tasks.className='grid';for(const task of model.behavior.journeys){const box=el('div',undefined,tasks);box.className='box';el('h3',task.title,box);el('p',task.summary,box);const b=el('button','Read this task',box);b.onclick=()=>show(task.entryId);}
el('h3','What the code contains',content);el('p',model.behavior.basis,content);for(const feature of model.behavior.features){const d=el('details',undefined,content);el('summary',feature.title,d);for(const e of feature.evidence)el('p',e.access+' · L'+e.line,d);for(const section of feature.sections){const c=byId.get(section.id);if(c)link(c,d);}}}
const eventDetails=el('details',undefined,content);el('summary','Events → handlers ('+model.events.length+')',eventDetails);for(const event of model.events){const row=el('div',undefined,eventDetails);el('span',event.event+' → ',row);if(event.handlerId){const b=el('button',event.handlerName,row);b.onclick=()=>show(event.handlerId);}else el('span',event.handlerName,row);}
el('h3','Shared context',content);el('p','Constants, shared variables, script initialization, and '+model.modules.length+' bundled modules remain in the full files. Function excerpts depend on those closures and the original bundle runtime. This view does not remove logic.',content);el('p','The built-in namer uses JavaScript rules, not a neural model. No code is sent to a service.',content);renderNav();content.scrollTop=0;}
search.oninput=renderNav;helpers.onchange=renderNav;document.getElementById('overview').onclick=overview;
if(browse)browse.onchange=renderNav;
if(byId.has(location.hash.slice(1)))show(location.hash.slice(1));else overview();
</script></body></html>\n`;
}
