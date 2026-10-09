// The viewer executes only its own code. Submitted source is inert JSON/text.
function viewer(){
  const model=JSON.parse(document.getElementById('model').textContent);
  const cards=new Map(model.cards.map(c=>[c.id,c])),information=model.information.cards;
  const content=document.getElementById('content'),nav=document.getElementById('nav'),search=document.getElementById('search');
  const el=(tag,text,parent)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(parent)parent.append(n);return n;};
  const button=(text,action,parent)=>{const b=el('button',text,parent);b.onclick=action;return b;};
  const heading=(title,description)=>{content.replaceChildren();el('h2',title,content);if(description)el('p',description,content);content.scrollTop=0;};
  const label=card=>card.friendlyName??card.name;
  function showHuman(){
    const human=model.humanReading;heading('Human reading version',human.scope);
    el('a','Open human-reading.js',content).href=human.file;
    el('p',human.stats.literalCandidates+' candidate literals exposed; '+human.stats.directProperties+' direct properties; '+human.stats.renamedFunctions+' inferred function names.',content);
    const filter=el('input',undefined,content);filter.placeholder='Find a function, API or category';filter.setAttribute('aria-label','Find a reading function');
    const list=el('div',undefined,content),lines=human.code.split('\n');
    const render=()=>{list.replaceChildren();const q=filter.value.toLowerCase();
      for(const f of human.functions.filter(f=>(f.name+' '+f.title+' '+f.category+' '+f.keys.join(' ')).toLowerCase().includes(q)))button(f.title+' · '+f.name+' · line '+f.line,()=>{
        heading(f.name,f.note);el('p','Analysis projection lines '+f.line+'–'+f.endLine+'. Verify in the complete source before treating an inference as runtime behavior.',content);
        el('pre',lines.slice(f.line-1,f.endLine).join('\n'),content);button('Back to reading functions',showHuman,content);
      },list);
    };filter.oninput=render;render();
  }
  function showDispatchers(){
    const reading=model.humanReading.dispatchers;heading('Inferred dispatcher paths',reading.scope);
    for(const m of reading.machines){const d=el('details',undefined,content);el('summary',m.name+' · cleaned line '+m.line+' · '+m.nodes.length+' states',d);
      if(m.pathCode){el('pre',m.pathCode,d);el('a','Open the structured candidate path',d).href=m.pathFile;}
      for(const n of m.nodes){el('h3','State '+n.id+' · numeric value '+n.discriminant,d);
        for(const edge of n.edges){el('p','When '+edge.when+': '+(edge.target?'state '+edge.target:edge.status),d);el('pre',edge.code,d);}
      }
      for(const u of m.unresolved)el('p','Unresolved state '+u.state+': '+u.reason,d);
    }el('a','Open the dispatcher report',content).href='reports/DISPATCHERS.md';
  }
  function showFunctionFiles(){
    heading('Read individual functions',model.functionReading.scope);
    const filter=el('input',undefined,content);filter.placeholder='Filter by title, API or original name';filter.setAttribute('aria-label','Filter functions');
    const list=el('div',undefined,content);
    function render(){list.replaceChildren();const query=filter.value.toLowerCase();
      for(const item of model.functionReading.functions.filter(item=>(item.title+' '+item.originalName+' '+item.keys.join(' ')).toLowerCase().includes(query)))
        button(item.title+' · '+item.originalName+' · '+item.lines+' lines',()=>{
          heading(item.title,item.note);el('p','Original identifier: '+item.originalName+' · cleaned line '+item.line,content);
          el('p','Enclosing bindings: '+(item.captures.join(', ')||'none'),content);el('pre',item.code,content);
          el('a','Open this function file',content).href=item.file;
          button('Back to function list',showFunctionFiles,content);
        },list);
    }
    filter.oninput=render;render();el('a','Open the function index',content).href='reports/FUNCTIONS.md';
  }
  function showEmbedded(){
    heading('Embedded code strings',model.embeddedCode.scope);
    for(const payload of model.embeddedCode.payloads){
      const detail=el('details',undefined,content);
      el('summary',payload.kind+' · payload '+payload.id+' · original line '+payload.sites[0].line,detail);
      el('pre',payload.code,detail);
      el('a','Open the readable payload',detail).href=payload.file;
      el('a','Open the original string',detail).href=payload.rawFile;
      if(payload.syntaxError||payload.analysisError)el('p',payload.syntaxError??payload.analysisError,detail);
    }
    for(const site of model.embeddedCode.unresolved??[])el('p','Unresolved '+site.kind+' at line '+site.line+': '+site.reason,content);
  }
  function showProgress(){
    heading('Readability progress',model.readabilityProgress.scope);
    const before=model.readabilityProgress.before,after=model.readabilityProgress.after;
    for(const [key,label] of [['hexBindings','Hexadecimal names'],['shortBindings','Other short names'],['computedProperties','Computed property expressions'],['switches','Switch statements']])
      el('p',label+': '+before[key]+' in the input → '+after[key]+' in cleaned code.',content);
    for(const example of after.examples)el('p',example.name+' · cleaned line '+example.line+' · '+example.reason,content);
    el('a','Open the full readability report',content).href='reports/READABILITY.md';
  }
  function pretty(value){if(value?.type==='string')return value.truncated?{text:value.text,length:value.length,truncated:true}:value.text;if(Array.isArray(value))return value.map(pretty);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,pretty(v)]));return value;}
  const sourceLink=(site,parent)=>{const a=el('a','Open the full file',parent);a.href=site.file;};
  function showSource(site){
    heading('The asking code',site.file+' · line '+site.line+(site.column?' · column '+site.column:''));
    el('p',site.basis??'A real excerpt from the cleaned source.',content);
    if(site.observedAccess)el('p','The VM saw this access: '+site.observedAccess+(site.sample?' · simulated value/detail: '+site.sample:''),content);
    const pre=el('pre',site.numberedCode??site.code,content);pre.className='code-focus';sourceLink(site,content);
    if(site.truncated)el('p','Long excerpt shortened for display. Open the source file for the complete expression.',content);
    el('p','This is a small excerpt. The surrounding function can contain conditions or callbacks that determine when it runs.',content);
    button('Back to information',showInformation,content);
  }
  function showInfo(id){const info=information.find(c=>c.id===id);if(!info)return;
    heading(info.title,info.explanation);
    el('span','Found in source code',content).className='badge';
    el('p',info.id==='info-listeners'?'This shows listener registration. A separate card appears if a simulated event field was actually read.':'A read or check does not by itself prove this information was saved or sent anywhere.',content);
    if(info.evidence.length){el('h3','Click an access to see its asking line',content);
      for(const evidence of info.evidence){const row=el('div',undefined,content);row.className='evidence';
        const text=evidence.label??evidence.target+(evidence.detail?' — '+evidence.detail:'');
        if(evidence.source)button(text,()=>showSource(evidence.source),row);else el('p',text+' · no input-code location available',row);
        el('small','Test step '+evidence.step+' · '+evidence.kind,row);
      }
    }
    if(info.readable.length){const d=el('details',undefined,content);d.open=info.status==='code-only';
      el('summary','Readable code with this kind of access',d);
      el('p','These are matches in the cleaned code. They are not claimed to be the same invocation recorded by the VM.',d);
      for(const site of info.readable)button(site.access+' · '+site.file+':'+site.line,()=>showSource(site),d);
    }
    if(!info.evidence.length&&!info.readable.length)el('p','No asking code was located.',content);
  }
  function infoTile(info,parent){const box=el('div',undefined,parent);box.className='box';
    button(info.title,()=>showInfo(info.id),box);
    el('span','Found in source code',box).className='badge';el('p',info.explanation,box);
  }
  function showInformation(){heading('What information does it look at?',model.information.intro);
    el('p',model.information.scope,content);const grid=el('div',undefined,content);grid.className='grid';
    for(const info of information)infoTile(info,grid);
    if(!information.length)el('p','No recognized information accesses were found. That does not prove there are none.',content);
  }
  function showShort(){const guide=model.shortReading;if(!guide)return;
    heading('Short code overview','Read one operation at a time. Click it to see the exact code.');
    el('p',guide.scope,content);
    if(model.reduction)el('p','Original program: '+model.reduction.originalLines+' formatted lines. Complete cleaned program: '+model.reduction.fullLines+' lines. The short guide has '+guide.lines+' lines and is an index, not a replacement program.',content);
    el('a','Open short-human-readable.js',content).href=guide.file;
    for(const site of guide.sites){const box=el('div',undefined,content);box.className='box';button(site.action,()=>showSource(site),box);el('small',site.target+' · complete source line '+site.line,box);}
    if(!guide.sites.length)el('p','No recognized calls in this index. Explore the function explanations and information cards instead.',content);
    if(guide.sites.length>=guide.limit)el('p','This index stops after '+guide.limit+' recognized call sites. The complete file and information inventory contain more detail.',content);
  }
  function fingerprintCategory(id,page=0){const inventory=model.fingerprints,c=inventory.categories.find(c=>c.id===id);if(!c)return;
    heading(c.title,c.explanation);el('p',c.staticSites+' code sites · '+c.status,content);
    el('p','A possible property-name match needs review. A read or listener does not prove that data was saved or sent.',content);
    const entries=inventory.findings.filter(f=>f.categories.includes(id));
    for(const f of entries.slice(page*40,(page+1)*40)){const box=el('div',undefined,content);box.className='box';
      const text=f.operation+' · '+f.access;
      if(f.source)button(text,()=>showSource(f.source),box);else el('p',text+' · no source location available',box);
      el('small',f.confidence??'Static source match',box);
      if(f.explanation)el('p',f.explanation,box);
    }
    if(!entries.length)el('p','No recognized evidence. Hidden or unexecuted code may still use this capability.',content);
    if(page>0)button('Previous 40',()=>fingerprintCategory(id,page-1),content);
    if((page+1)*40<entries.length)button('Next 40',()=>fingerprintCategory(id,page+1),content);
    button('All fingerprint categories',showFingerprints,content);
  }
  function showFingerprints(){if(!model.fingerprints)return;const inventory=model.fingerprints;
    heading('Fingerprint inventory','Click a category to see every recognized asking line. Code sites and test observations have separate source files.');
    el('p',inventory.scope,content);
    const grid=el('div',undefined,content);grid.className='grid';
    for(const c of inventory.categories){const box=el('div',undefined,grid);box.className='box';button(c.title,()=>fingerprintCategory(c.id),box);el('p',c.staticSites+' code sites · '+c.status,box);}
    const d=el('details',undefined,content);el('summary','Coverage and unknowns',d);
    for(const limit of inventory.coverage.limits)el('p',limit,d);
    el('p',inventory.coverage.unresolvedComputedSites+' unresolved computed-property sites.',d);
    for(const error of inventory.coverage.traceErrors)el('p',error.phase+': '+error.message,d);
    el('a','Download the JSON inventory',content).href='reports/fingerprints.json';
    el('p','The JavaScript evidence file contains line-numbered excerpts as strings. Opening or importing it does not execute the submitted operations.',content);
    el('a','Open fingerprint-collection.js',content).href='src/fingerprint-collection.js';
  }
  function showFunction(id){const card=cards.get(id);if(!card)return;
    heading(label(card),card.friendlySummary??card.summary);el('p','Cleaned source: '+model.sourceFile+' · line '+card.line,content);
    const steps=el('ol',undefined,content);for(const step of card.steps?.slice(0,5)??[])el('li',step,steps);
    if(card.focus?.length){el('h3','Short code view',content);el('p','Only selected real operations are shown here. The complete function is below.',content);
      for(const part of card.focus){const box=el('div',undefined,content);box.className='box';el('small',part.title+' · line '+part.line,box);el('pre',part.code,box);}
    }
    for(const target of card.links.slice(0,5)){const next=cards.get(target.id);if(next)button('Continue → '+label(next),()=>showFunction(next.id),content);}
    const full=el('details',undefined,content);el('summary','Full function · '+card.lines+' lines',full);el('pre',card.code,full);
    if(card.taskFile){el('p','This task also has its own small reading file. It depends on shared state and helpers in the complete program.',content);el('a','Open the task extract',content).href=card.taskFile;}
    const technical=el('details',undefined,content);el('summary','Technical details',technical);el('p','Function name: '+card.name,technical);
    el('p','Calls: '+card.calls.join(', '),technical);el('p','Assignments: '+card.writes.join(', '),technical);
    for(const stage of card.stages??[])button(stage.name,()=>showFunction(stage.id),technical);
  }
  function showFlow(){heading('What steps can you start?', 'Choose a task. Each task opens a short explanation before its full code.');
    for(const task of model.behavior?.journeys??[]){const c=cards.get(task.entryId);const box=el('div',undefined,content);box.className='box';
      button(c?label(c):task.title,()=>showFunction(task.entryId),box);el('p',c?.friendlySummary??task.summary,box);
    }
  }
  function overview(){heading('Understand the script in small pieces.', 'Start with what it looks at. Click a card to see the asking code.');
    if(model.shortReading){button('Short code overview · '+model.shortReading.sites.length+' operations',showShort,content);el('p','Start here for a small list of requests, saved values, drawing checks, encryption and events found in the code.',content);}
    if(model.reduction)el('p',model.reduction.originalLines+' original formatted lines → '+model.reduction.fullLines+' complete cleaned lines. Removed unused local code; remaining unknown logic is kept.',content);
    el('p','This is an offline static code inspection. Input was not executed.',content);
    const grid=el('div',undefined,content);grid.className='grid';for(const info of information.slice(0,8))infoTile(info,grid);
    if(information.length>8)button('See all '+information.length+' information groups',showInformation,content);
    if(model.fingerprints)button('Fingerprint inventory · every recognized code site',showFingerprints,content);
    if(model.fullReadable){const d=el('details',undefined,content);el('summary','Complete human-readable file · '+model.fullReadable.outputLines+' lines',d);
      el('p','All cleaned program logic is included in expanded statements. The parsed structure is checked against readable.js; browser behavior still needs integration validation.',d);el('a','Open full-human-readable.js',d).href=model.fullReadable.file;}
    if(model.humanReading){button('Read the simplified candidate version',showHuman,content);button('Read inferred dispatcher paths',showDispatchers,content);}
    el('h3','Then follow a task',content);button('Show the steps',showFlow,content);
    if(model.taskReading){const d=el('details',undefined,content);el('summary','Short file for the main tasks · '+model.taskReading.lines+' lines',d);
      el('p','Real task code only. Shared state and other helpers remain in the complete source; this extract cannot replace the full program.',d);el('a','Open essentials.js',d).href=model.taskReading.file;}
    el('p','You do not need to read thousands of lines. The source is available when you want to check an explanation.',content);
  }
  function renderNav(){nav.replaceChildren();const q=search.value.trim().toLowerCase();
    if(q){for(const info of information.filter(i=>(i.title+' '+i.explanation+' '+i.accesses.join(' ')).toLowerCase().includes(q)))button(info.title,()=>showInfo(info.id),nav);
      for(const c of model.cards.filter(c=>(c.name+' '+c.summary+' '+c.code).toLowerCase().includes(q)).slice(0,60))button(label(c),()=>showFunction(c.id),nav);return;}
    el('small','Start here',nav);button('Overview',overview,nav);button('What information?',showInformation,nav);button('What steps?',showFlow,nav);
    if(model.shortReading)button('Short code overview',showShort,nav);
    if(model.humanReading){button('Human reading functions',showHuman,nav);button('Dispatcher paths',showDispatchers,nav);}
    if(model.functionReading?.functions.length)button('Read individual functions · '+model.functionReading.functions.length,showFunctionFiles,nav);
    if(model.embeddedCode?.payloads.length)button('Embedded code · '+model.embeddedCode.payloads.length,showEmbedded,nav);
    if(model.readabilityProgress)button('Readability progress',showProgress,nav);
    if(model.fingerprints)button('Fingerprint inventory',showFingerprints,nav);
    const d=el('details',undefined,nav);el('summary','Explore functions',d);
    for(const c of model.cards.filter(c=>!['Compiler helpers','Obfuscation scaffolding','Async state machines'].includes(c.category)))button(label(c),()=>showFunction(c.id),d);
    const extra=el('details',undefined,nav);el('summary','Advanced: helpers and async stages',extra);
    for(const c of model.cards.filter(c=>['Compiler helpers','Obfuscation scaffolding','Async state machines'].includes(c.category)))button(c.name,()=>showFunction(c.id),extra);
  }
  search.oninput=renderNav;renderNav();overview();
}

export function noviceReaderHtml(model){
  const data=JSON.stringify(model).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>What is this JavaScript doing?</title>
<style>
:root{color-scheme:dark;--bg:#101720;--panel:#1b2634;--text:#eef4fa;--muted:#b7c6d8;--line:#34465b;--accent:#86dfcb}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,sans-serif}header{padding:22px 30px;border-bottom:1px solid var(--line)}h1{font-size:24px;margin:0}p{color:var(--muted);margin:10px 0}main{display:grid;grid-template-columns:270px minmax(0,1fr);height:calc(100vh - 112px);min-height:550px}aside{padding:20px;border-right:1px solid var(--line);overflow:auto}article{padding:30px 38px;overflow:auto;min-width:0}h2{font-size:28px;margin:0 0 14px}h3{font-size:20px;margin:25px 0 8px}input{width:100%;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:8px;color:var(--text);font:inherit}button{padding:9px 14px;background:var(--panel);border:1px solid var(--line);border-radius:8px;color:var(--text);font:inherit;text-align:left;cursor:pointer;margin:5px 6px 5px 0;overflow-wrap:anywhere}button:hover{border-color:var(--accent);color:var(--accent)}nav button{display:block;width:100%}small{display:block;color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:15px;margin:22px 0}.box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin:12px 0}.grid .box{margin:0}.box button{font-weight:650;padding-left:0;border:0;color:var(--accent)}.badge{display:block;font-size:12px;color:var(--accent);margin:5px 0}.evidence{border-bottom:1px solid var(--line);padding:10px 0}pre{background:#0b1119;padding:18px;border:1px solid var(--line);border-radius:10px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 Consolas,monospace}a{color:var(--accent)}details{margin:18px 0}summary{cursor:pointer;color:var(--muted)}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}@media(max-width:760px){main{display:block;height:auto}aside{border-right:0;border-bottom:1px solid var(--line);max-height:280px}article{padding:24px}header{padding:20px}h2{font-size:24px}}
</style></head><body><header><h1>What is this JavaScript doing?</h1><p>Plain-language explanations. Click an access to see its code.</p></header><main><aside><input id="search" type="search" aria-label="Search explanations and code" placeholder="Search information or tasks"><nav id="nav"></nav></aside><article id="content" aria-live="polite"></article></main><script type="application/json" id="model">${data}</script><script>(${viewer.toString()})();</script></body></html>\n`;
}
