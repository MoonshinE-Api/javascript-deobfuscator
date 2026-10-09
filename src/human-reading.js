import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
import {batchRename} from './batch-rename.js';
import {reserveName} from './reserve-name.js';
import {dynamicBindings} from './dynamic-scope.js';
import {inspectFunction} from './function-reading.js';
import {nameBindings} from './namer.js';
import {statementLayout} from './statement-layout.js';
import {dispatcherReading} from './dispatcher-reading.js';
import {cachedDecoder} from './cached-strings.js';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule;
const print=node=>generate(node,{comments:true,jsescOption:{minimal:true}}).code;
const clean=value=>String(value).replaceAll('*/','* /').replace(/[\r\n\u2028\u2029]/g,' ');
const opaque=name=>/^[_$]*(?:[A-Za-z]{1,3}\d*|0x[\da-f]+)$/i.test(name);
const titles={Requests:'requestHelper',Storage:'storageHelper',Events:'eventHelper',Graphics:'graphicsHelper',Timing:'timingHelper','String decoding':'decodeText',Crypto:'cryptoHelper',Document:'documentHelper',Data:'jsonHelper','State machines':'stateDispatcher'};
const roles={'Base91 byte decoder':'decodeBase91Bytes','Text decoding helper':'decodeUtf8Text','Read saved browser values':'readBrowserStorage','Write saved browser values':'writeBrowserStorage','Cookie helper':'handleCookies','Event listener helper':'registerEventListeners','Input event helper':'readInputEvent','Document element helper':'handleDocumentElement','Performance timing helper':'readPerformanceTiming'};

function facade(p){
  const n=p.node,[index,text]=n.params;
  if(!t.isFunctionDeclaration(n)||n.async||n.generator||!t.isIdentifier(index)||!t.isIdentifier(text)||n.params.length!==2||n.body.body.length!==1)return null;
  const s=n.body.body[0];if(!t.isIfStatement(s)||!t.isBinaryExpression(s.test,{operator:'==='}))return null;
  const zero=node=>t.isIdentifier(node,{name:'undefined'})&&!p.scope.getBinding('undefined')||t.isUnaryExpression(node,{operator:'void'})&&t.isNumericLiteral(node.argument,{value:0});
  const access=zero(s.test.left)?s.test.right:zero(s.test.right)?s.test.left:null;
  if(!t.isMemberExpression(access)||!access.computed||!t.isIdentifier(access.object)||!t.isIdentifier(access.property,{name:index.name}))return null;
  const ret=node=>t.isBlockStatement(node)&&node.body.length===1?node.body[0]:node;
  const yes=ret(s.consequent),no=ret(s.alternate);
  const same=node=>t.isNodesEquivalent(node,access);
  if(!t.isReturnStatement(yes)||!t.isAssignmentExpression(yes.argument,{operator:'='})||!same(yes.argument.left)||!t.isIdentifier(yes.argument.right,{name:text.name})||!t.isReturnStatement(no)||!same(no.argument))return null;
  return {binding:p.parentPath.scope.getBinding(n.id.name),cache:p.scope.getBinding(access.object.name),path:p};
}

// This is deliberately a separate analysis projection. Replacing a shared-cache
// read by its candidate can change behavior; inferred function names can change
// Function.name. The complete output keeps those operations intact.
export function humanReading(source,{maxDataBytes=8*1024*1024,dictionarySource}={}){
  const ast=parse(source,{sourceType:'unambiguous'}),facades=new Map(),values=new Map(),candidates=[],renames=[],tables=[],internals=[];
  const stats={literalCandidates:0,conflictingCacheIndices:0,directProperties:0,renamedFunctions:0,externalizedTables:0};
  const dictionaries=new Map(),codecNames=new Set(),originalNames=new Map();
  const contextKey=(name,p)=>{const parents=[];for(let parent=p.getFunctionParent();parent;parent=parent.getFunctionParent())if(parent.node.id)parents.push(originalNames.get(parent.node.id.name)??parent.node.id.name);return JSON.stringify([originalNames.get(name)??name,parents]);};
  if(dictionarySource){
    const input=parse(dictionarySource,{sourceType:'unambiguous'});
    traverse(input,{Function(p){const schema=cachedDecoder(p);if(!schema)return;
      if(schema.decoder?.path.isFunctionDeclaration())codecNames.add(contextKey(schema.decoder.identifier.name,schema.decoder.path));
      if(!schema.binding)return;const k=contextKey(schema.binding.identifier.name,p);if(!dictionaries.has(k))dictionaries.set(k,[]);dictionaries.get(k).push(schema);
    }});
  }
  traverse(ast,{FunctionDeclaration(p){const f=facade(p);if(f?.binding&&f.cache)facades.set(f.binding,f);}});
  traverse(ast,{CallExpression(p){
    if(!t.isIdentifier(p.node.callee))return;const f=facades.get(p.scope.getBinding(p.node.callee.name));
    const [index,text]=p.node.arguments;if(!f||p.node.arguments.length!==2||!t.isNumericLiteral(index)||!t.isStringLiteral(text))return;
    let indices=values.get(f.cache);if(!indices)values.set(f.cache,indices=new Map());
    let texts=indices.get(index.value);if(!texts)indices.set(index.value,texts=new Set());texts.add(text.value);
    candidates.push({path:p,facade:f,index:index.value,text:text.value,line:p.node.loc?.start.line});
  }});
  for(const indices of values.values())stats.conflictingCacheIndices += [...indices.values()].filter(v=>v.size>1).length;
  const literalSites=[];
  for(const entry of candidates){
    if(values.get(entry.facade.cache).get(entry.index).size!==1)continue;
    literalSites.push({line:entry.line,index:entry.index,value:entry.text,cache:entry.facade.cache.identifier.name});
    entry.path.replaceWith(t.stringLiteral(entry.text));stats.literalCandidates++;
  }
  traverse(ast,{MemberExpression(p){if(p.node.computed&&t.isStringLiteral(p.node.property)&&t.isValidIdentifier(p.node.property.value)){p.node.computed=false;p.node.property=t.identifier(p.node.property.value);stats.directProperties++;}}});
  // Reuse the ordinary namer after decoded properties have become visible.
  const inferredLocals=nameBindings(ast);
  traverse(ast,{Program(p){p.scope.crawl();p.stop();}});
  const dynamic=dynamicBindings(ast),plans=new Map(),reserved=new WeakMap();
  traverse(ast,{Scopable(p){for(const binding of Object.values(p.scope.bindings)){
    if(binding.scope!==p.scope||!opaque(binding.identifier.name)||dynamic.has(binding)||!binding.path.isVariableDeclarator())continue;
    const props=new Set();for(const ref of binding.referencePaths)if(ref.parentPath.isMemberExpression()&&ref.parentPath.node.object===ref.node&&!ref.parentPath.node.computed)props.add(ref.parentPath.node.property.name);
    let role;if(props.has('protocol')&&props.has('hostname'))role='pageLocation';
    else if(props.has('userAgent')&&props.has('platform'))role='browserNavigator';
    else if(props.has('createElement')&&props.has('documentElement'))role='browserDocument';
    else if(props.has('navigator')&&props.has('document'))role='browserWindow';
    if(role){const from=binding.identifier.name,to=reserveName(binding,role,reserved);plans.set(binding,to);renames.push({from,to,line:binding.identifier.loc?.start.line,title:'API receiver',reason:'Observed properties: '+[...props].slice(0,10).join(', ')});}
  }}});
  traverse(ast,{Function(p){
    if(!p.node.id||!opaque(p.node.id.name))return;
    const binding=p.isFunctionDeclaration()?p.parentPath.scope.getBinding(p.node.id.name):p.scope.getBinding(p.node.id.name);
    if(!binding||dynamic.has(binding))return;
    const info=inspectFunction(p);let role=roles[info.title]??titles[info.category];
    if(info.title.startsWith('Read '))role='read'+info.title.slice(5).replace(/[^A-Za-z0-9_$]/g,'');
    let chars=false,shift=false;
    p.traverse({Function(q){q.skip();},MemberExpression(q){if(!q.node.computed&&t.isIdentifier(q.node.property,{name:'charCodeAt'}))chars=true;},BinaryExpression(q){if(['<<','>>','>>>'].includes(q.node.operator))shift=true;}});
    if(chars&&shift&&info.category==='Utility')role='hashText';
    if(!role)return;const from=binding.identifier.name,to=reserveName(binding,role+'_'+from,reserved);
    plans.set(binding,to);renames.push({from,to,line:p.node.loc?.start.line,title:info.title,reason:info.note});
    p.node.leadingComments=(p.node.leadingComments??[]).filter(c=>!c.value.includes('Reading note:'));
    t.addComment(p.node,'leading',' Inferred reading name '+clean(to)+'; original '+clean(from)+'. '+clean(info.note)+' ');
  }});
  stats.renamedFunctions=renames.filter(r=>r.title!=='API receiver').length;
  stats.renamedApiReceivers=renames.filter(r=>r.title==='API receiver').length;
  batchRename(ast,plans);
  for(const rename of renames)originalNames.set(rename.to,rename.from);
  statementLayout(ast);
  stats.pathLiteralCandidates=0;
  const dispatchers=dispatcherReading(ast,{resolveCandidate(name,index,scope){
    if(!Number.isInteger(index)||index<0)return;const binding=scope.getBinding(name);if(!binding?.path.isFunctionDeclaration())return;
    const entries=dictionaries.get(contextKey(binding.identifier.name,binding.path));if(entries?.length!==1)return;const schema=entries[0],encoded=schema.table.path.node.init.elements[index];if(!encoded)return;
    let decoded;try{decoded=schema.decode(encoded.value);}catch{return;}if(typeof decoded==='string'){stats.pathLiteralCandidates++;return decoded;}
  }});
  traverse(ast,{Function(p){
    if(!p.isFunctionDeclaration()&&!p.isFunctionExpression()||!t.isBlockStatement(p.node.body))return;
    const info=inspectFunction(p),known=p.node.id&&codecNames.has(contextKey(p.node.id.name,p));
    let nested=false;p.traverse({Function(q){nested=true;q.skip();}});
    const lines=(p.node.body.loc?.end.line??0)-(p.node.body.loc?.start.line??0);
    // Environment initialization can mention codec APIs without being a codec.
    // Never externalize a containing application/factory function on API clues.
    if(nested||lines<8||!known&&(info.title!=='Base91 byte decoder'||lines>150))return;
    const id=String(internals.length+1).padStart(3,'0'),file='src/reading-internals/'+id+'.js';
    internals.push({file,name:p.node.id?.name??'decoderCallback',line:p.node.loc?.start.line,title:info.title,code:print(p.isFunctionDeclaration()?p.node:t.expressionStatement(t.cloneNode(p.node,true)))+'\n'});
    p.node.body=t.blockStatement([t.returnStatement(t.callExpression(t.identifier('__readingInternal'),[t.stringLiteral(file),t.identifier('arguments')]))]);
    t.addComment(p.node.body,'inner',' Decoder implementation moved to '+file+' for reading. ');
    p.skip();
  }});
  let dataBytes=0;
  traverse(ast,{VariableDeclarator(p){
    const n=p.node.init;if(!t.isArrayExpression(n)||n.elements.length<32||!n.elements.every(e=>t.isStringLiteral(e)||t.isNumericLiteral(e)||t.isBooleanLiteral(e)||t.isNullLiteral(e)||t.isUnaryExpression(e,{operator:'-'})&&t.isNumericLiteral(e.argument)))return;
    const data=n.elements.map(e=>t.isNullLiteral(e)?null:t.isUnaryExpression(e)?-e.argument.value:e.value),bytes=Buffer.byteLength(JSON.stringify(data));
    if(bytes<400||dataBytes+bytes>maxDataBytes)return;dataBytes+=bytes;
    const id=String(tables.length+1).padStart(3,'0'),file='src/reading-data/'+id+'.json';
    tables.push({file,name:t.isIdentifier(p.node.id)?p.node.id.name:'table',line:n.loc?.start.line,entries:data.length,data});
    p.get('init').replaceWith(t.callExpression(t.identifier('__readingData'),[t.stringLiteral(file)]));stats.externalizedTables++;
  }});
  const header=['// HUMAN READING PROJECTION — for inspection, not execution.',
    '// Decoded candidates replace shared-cache calls; runtime cache order is not reproduced.',
    '// Function names are inferred clues. Tables and codec internals are saved separately.',
    '// Use full-human-readable.js for the complete cleaned program.',
    '// Unresolved dispatchers remain below; see reports/DISPATCHERS.md for traced candidate paths.',''];
  // Keep tiny helpers on one line; longer logic retains expanded statements.
  traverse(ast,{noScope:true,BlockStatement(p){if(p.node.body.length>4||p.node.directives.length||p.node.body.some(n=>/^(If|For|While|DoWhile|Switch|Try)/.test(n.type)))return;
    const text=generate(p.node,{concise:true,comments:true}).code;if(text.length<=140&&!text.includes('\n')&&!text.includes('//'))p.node._compact=true;
  }});
  const code=header.join('\n')+print(ast)+'\n';parse(code,{sourceType:'unambiguous'});
  const functions=[];
  traverse(parse(code,{sourceType:'unambiguous'}),{Function(p){
    const lines=p.node.loc.end.line-p.node.loc.start.line+1;if(lines>400)return;
    const name=p.node.id?.name??(p.parentPath.isVariableDeclarator()?p.parentPath.node.id.name:null)??'callback';
    const info=inspectFunction(p);functions.push({name,line:p.node.loc.start.line,endLine:p.node.loc.end.line,...info});
  }});
  return {code,tables,internals,dispatchers,functions,renames,literalSites,stats:{...stats,externalizedDecoders:internals.length,localRenames:inferredLocals.renames.length,lines:code.trimEnd().split('\n').length,dataBytes},
    scope:'Analysis projection: candidate literals and inferred names help reading but can change runtime cache and reflection behavior. Tables are externalized. It must not be executed as the original program.'};
}

export function humanReadingMarkdown(reading){
  return ['# Human reading version','',reading.scope,'',
    'Start with [human-reading.js](../src/human-reading.js). Use [the complete program](../src/full-human-readable.js) to check every inference.',
    '',`${reading.stats.literalCandidates} candidate calls simplified; ${reading.stats.directProperties} direct property names; ${reading.stats.renamedFunctions} inferred function names; ${reading.stats.externalizedTables} data tables moved to separate JSON files.`,
    '', 'Function names describe syntax clues, not recovered original names. A shared-cache candidate can differ from the runtime value even when visible candidates agree.',
    '', '## Function name map','', '| Original | Reading name | Original cleaned line | Evidence |','|---|---|---:|---|',
    ...reading.renames.map(r=>`| ${r.from} | ${r.to} | ${r.line} | ${clean(r.reason).replaceAll('|','\\|')} |`),
    '', '## Data tables','',...reading.tables.map(v=>`- ${v.name}: ${v.entries} entries, [JSON](../${v.file}); cleaned line ${v.line}.`),''].join('\n');
}
