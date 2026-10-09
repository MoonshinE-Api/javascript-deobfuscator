import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule;
const field=n=>n?.computed?t.isStringLiteral(n.property)?n.property.value:null:n?.property?.name;
const pascal=value=>value.replace(/[^\w]+(.)?/g,(_,c)=>c?.toUpperCase()??'').replace(/^./,c=>c.toUpperCase()).slice(0,60);
const commentText=value=>value.replaceAll('*/','* /').replace(/[\r\n\u2028\u2029]/g,' ');
export function inspectFunction(p){
  const keys=new Set(),strings=new Set(),calls=new Set(),constructors=new Set();let dynamic=0;
  p.traverse({Function(q){q.skip();},WithStatement(){dynamic++;},MemberExpression(q){const key=field(q.node);if(key)keys.add(key);},StringLiteral(q){if(q.node.value.length<120&&q.node.value.length>2)strings.add(q.node.value);},
    NewExpression(q){if(t.isIdentifier(q.node.callee))constructors.add(q.node.callee.name);},
    CallExpression(q){const key=field(q.node.callee);if(key)calls.add(key);else if(t.isIdentifier(q.node.callee))calls.add(q.node.callee.name);
      if(t.isIdentifier(q.node.callee)&&/readDecodedString/.test(q.node.callee.name)&&t.isStringLiteral(q.node.arguments[1]))keys.add(q.node.arguments[1].value);
    }
  });
  let title,note,category='Utility';
  const has=(...names)=>names.some(name=>keys.has(name));
  if(dynamic){title='Object-scoped state machine';note='Uses dynamic object scopes and a dispatcher; unresolved control flow is retained.';category='State machines';}
  else if(has('XMLHttpRequest','sendBeacon','fetch')||calls.has('fetch')||constructors.has('XMLHttpRequest')||calls.has('send')&&has('setRequestHeader','responseText')){title='Request helper';note='Contains request setup or transmission operations.';category='Requests';}
  else if(has('setItem','removeItem','getItem')||calls.has('getItem')||calls.has('setItem')){title=has('setItem')||calls.has('setItem')?'Write saved browser values':'Read saved browser values';note='Uses browser storage keys or values.';category='Storage';}
  else if(has('cookie')){title='Cookie helper';note='Contains cookie access or cookie-text handling.';category='Storage';}
  else if(has('addEventListener','removeEventListener')||calls.has('addEventListener')){title='Event listener helper';note='Registers, removes or prepares event listeners.';category='Events';}
  else if(has('pageX','clientX','touches','movementX','keyCode','keyboard')){title='Input event helper';note='Reads input-event fields or builds their records.';category='Events';}
  else if(has('postMessage','onmessage')||calls.has('postMessage')||constructors.has('Worker')||constructors.has('SharedWorker')){title='Worker or frame message helper';note='Contains message-channel access or worker construction; the receiver and runtime path require context.';category='Messaging';}
  else if(has('userAgent','hardwareConcurrency','deviceMemory','webdriver','languages','mimeTypes')){title='Browser characteristics helper';note='Accesses browser or device characteristic properties; this does not establish which values were transmitted.';category='Device';}
  else if(has('getContext','toDataURL','getImageData','readPixels','getParameter')){title='Graphics data helper';note='Contains canvas or graphics API operations.';category='Graphics';}
  else if(has('getEntriesByType','getEntries','responseStart','timeOrigin','now')){title='Performance timing helper';note='Reads or combines timing values.';category='Timing';}
  else if(has('charCodeAt','fromCharCode','indexOf')&&[...strings].some(value=>value.length===91)){title='Base91 byte decoder';note='Decodes an encoded character stream into bytes.';category='String decoding';}
  else if(has('TextDecoder','fromCharCode','fromCodePoint','decode')&&has('Uint8Array','join','charCodeAt')){title='Text decoding helper';note='Contains byte-to-text conversion operations.';category='String decoding';}
  else if(has('encrypt','decrypt','digest','importKey','exportKey')){title='Crypto helper';note='Uses cryptographic API operations.';category='Crypto';}
  else if(has('appendChild','createElement','querySelector','getAttribute','setAttribute','removeChild')){title='Document element helper';note='Reads or changes document elements or their attributes.';category='Document';}
  else if(has('stringify','parse')){title='JSON data helper';note='Parses or serializes structured text.';category='Data';}
  else if(p.node.body?.body?.length===1&&t.isReturnStatement(p.node.body.body[0])){
    const expr=p.node.body.body[0].argument,key=t.isMemberExpression(expr)?field(expr):null;
    if(key){title='Read '+key;note='Returns the '+key+' property.';}
  }
  if(!title){title='Utility function';note=calls.size?'Direct method calls: '+[...calls].slice(0,5).join(', ')+'.':'Its application role remains uncertain.';}
  const examples=[...keys].filter(value=>/^[A-Za-z][A-Za-z0-9]{3,45}$/.test(value)).slice(0,8);
  return {title,note,category,keys:examples,dynamic};
}
export function annotateFunctions(ast){
  const stats={annotatedFunctions:0,unresolvedStateMachines:0};
  traverse(ast,{Function(p){
    const info=inspectFunction(p);stats.unresolvedStateMachines+=info.dynamic;
    if(info.title==='Utility function'||(p.node.leadingComments??[]).some(comment=>comment.value.includes('Reading note:')))return;
    const note=commentText(info.title+'. '+info.note);
    t.addComment(p.node,'leading',' Reading note: '+note+' ');stats.annotatedFunctions++;
  }});return stats;
}
export function functionReading(source,{maxFunctions=250,maxBytes=4*1024*1024}={}){
  const ast=parse(source,{sourceType:'unambiguous'}),items=[];let bytes=0;
  traverse(ast,{Function(p){
    if(!p.isFunctionDeclaration()&&!p.isFunctionExpression()&&!p.isArrowFunctionExpression())return;
    let classContext=false;t.traverseFast(p.node,node=>{if(t.isSuper(node)||t.isPrivateName(node))classContext=true;});if(classContext)return;
    const lines=p.node.loc.end.line-p.node.loc.start.line+1;if(lines>400||lines<3)return;
    const originalName=p.node.id?.name??(p.parentPath.isVariableDeclarator()?p.parentPath.node.id.name:null)??(p.parentPath.isObjectProperty()?field({computed:p.parentPath.node.computed,property:p.parentPath.node.key}):null)??'callback';
    const info=inspectFunction(p),captures=new Set();
    p.traverse({ReferencedIdentifier(q){const binding=q.scope.getBinding(q.node.name);if(binding&&binding.scope!==p.scope&&!binding.path.findParent(parent=>parent===p))captures.add(q.node.name);}});
    const text=t.isFunctionDeclaration(p.node)?generate(p.node,{comments:true}).code:generate(t.expressionStatement(t.cloneNode(p.node,true)),{comments:true}).code;
    const code='// Reading fragment from cleaned lines '+p.node.loc.start.line+'-'+p.node.loc.end.line+'.\n// '+commentText(info.title+': '+info.note)+'\n// Enclosing bindings: '+([...captures].slice(0,24).join(', ')||'none')+'.\n// Keep the complete program for its initialization and enclosing context.\n'+text+'\n';
    items.push({...info,originalName,line:p.node.loc.start.line,endLine:p.node.loc.end.line,lines,captures:[...captures],code});
  }});
  const selected=[];
  for(const item of items.sort((a,b)=>(a.title==='Utility function')-(b.title==='Utility function')||a.lines-b.lines||a.line-b.line)){
    const length=Buffer.byteLength(item.code);if(selected.length>=maxFunctions||bytes+length>maxBytes)continue;
    bytes+=length;const id=String(selected.length+1).padStart(3,'0'),slug=pascal(item.title).replace(/[^A-Za-z0-9]/g,'')||'Function';
    selected.push({...item,id,file:'src/functions/'+id+'-'+slug+'.js'});
  }
  return {functions:selected,totalCandidates:items.length,bytes,scope:'Syntax-based reading fragments from the complete cleaned program. They retain unresolved code and require their enclosing bindings; titles do not prove execution or complete behavior.'};
}
export function functionIndexMarkdown(reading){
  const cell=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('|','\\|').replace(/[\r\n]/g,' ');
  return ['# Read functions one at a time','',reading.scope,'','The complete program is [full-human-readable.js](../src/full-human-readable.js).','',
    '| Reading title | Original identifier | Cleaned line | Fragment |','|---|---|---:|---|',
    ...reading.functions.map(item=>`| ${cell(item.title)} | ${cell(item.originalName)} | ${item.line} | [Open function](../${item.file}) |`),
    '',`${reading.functions.length} fragments saved from ${reading.totalCandidates} eligible functions.`].join('\n')+'\n';
}
