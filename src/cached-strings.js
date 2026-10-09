import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
import {initializedFor} from './initialized-binding.js';
import {staticValue,UNKNOWN_STATIC} from './static-values.js';
import {primitiveHelper,interpretHelper,UNKNOWN_HELPER} from './primitive-helpers.js';
import {inWith} from './dynamic-scope.js';
import {staticSafety} from './static-safety.js';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule;
const field=n=>n?.computed?t.isStringLiteral(n.property)?n.property.value:null:n?.property?.name;
const ignored=new Set(['start','end','loc','extra','leadingComments','trailingComments','innerComments','comments','tokens','errors']);
const structure=n=>Array.isArray(n)?n.map(structure):n&&typeof n==='object'?Object.fromEntries(Object.entries(n).filter(([key])=>!ignored.has(key)).map(([key,value])=>[key,structure(value)])):n;
function canonical(node,externals={}){
  const copy=parse(generate(node,{comments:false}).code);const names=new Map();let id=0;
  traverse(copy,{Scopable(p){for(const binding of Object.values(p.scope.bindings))if(!names.has(binding))names.set(binding,'local'+id++);}});
  traverse(copy,{Identifier(p){if(!p.isReferencedIdentifier()&&!p.isBindingIdentifier())return;const binding=p.scope.getBinding(p.node.name);p.node.name=names.get(binding)??externals[p.node.name]??p.node.name;}});
  return JSON.stringify(structure(copy.program.body));
}
const byteTemplate=parse(`function decode(t){for(var n=""+(t||""),e=n.length,g=[],r=0,i=0,o=-1,a=0;a<e;a++){var c="ALPHABET".indexOf(n[a]);if(-1!==c)if(o<0)o=c;else{r|=(o+=91*c)<<i,i+=(8191&o)>88?13:14;do{g.push(255&r),r>>=8,i-=8;}while(i>7);o=-1;}}return o>-1&&g.push(255&(r|o<<i)),g;}`).program.body[0];
const bytesSignature=canonical(byteTemplate);
const bridgeTemplate=parse(`function text(t){return void 0!==TextDecoderAlias&&TextDecoderAlias?new TextDecoderAlias().decode(new Uint8ArrayAlias(t)):void 0!==BufferAlias&&BufferAlias?BufferAlias.from(t).toString("utf-8"):utf8Fallback(t);}`).program.body[0];
const bridgeSignature=canonical(bridgeTemplate);
const discoverySignature=canonical(parse(`function discover(){var t,n=[function(){return globalThis;},function(){return global;},function(){return window;},function(){return new Function("return this")();}],e=[];try{t=Object,e.push("".__proto__.constructor.name);}catch(t){}t:for(var g=0;g<n.length;g++)try{t=n[g]();for(var r=0;r<e.length;r++)if(void 0===t[e[r]])continue t;return t;}catch(t){}return t||this;}`).program.body[0]);
function nativeNamespace(node,scope,seen=new Set()){
  if(!t.isIdentifier(node))return false;
  const binding=scope.getBinding(node.name);
  if(!binding)return ['globalThis','global','window','self'].includes(node.name);
  if(!binding.constant||!binding.path.isVariableDeclarator()||seen.has(binding)||seen.size>40)return false;
  seen=new Set([...seen,binding]);
  const init=binding.path.node.init;
  if(t.isIdentifier(init))return nativeNamespace(init,binding.path.scope,seen);
  if(!t.isLogicalExpression(init,{operator:'||'})||!t.isObjectExpression(init.right)||init.right.properties.length||!t.isCallExpression(init.left)||init.left.arguments.length||!t.isIdentifier(init.left.callee))return false;
  const getter=binding.path.scope.getBinding(init.left.callee.name);
  return getter?.constant&&getter.path.isFunctionDeclaration()&&['globalThis','global','window','Function','Object'].every(name=>!getter.path.scope.getBinding(name))&&canonical(getter.path.node)===discoverySignature;
}

export function utf8Bridge(binding){
  if(!binding?.constant||!binding.path.isFunctionDeclaration()||binding.path.node.params.length!==1||binding.path.node.async||binding.path.node.generator)return false;
  const names={};let fallback;
  binding.path.traverse({ReferencedIdentifier(p){
    if(p.scope.getBinding(p.node.name)?.scope===binding.path.scope)return;
    const target=p.scope.getBinding(p.node.name);
    if(target?.constant&&target.path.isVariableDeclarator()&&t.isMemberExpression(target.path.node.init)){
      const key=field(target.path.node.init);if(['TextDecoder','Uint8Array','Buffer'].includes(key)&&nativeNamespace(target.path.node.init.object,target.path.scope))names[p.node.name]=key+'Alias';
    }else if(target?.constant&&target.path.isVariableDeclarator()&&t.isCallExpression(target.path.node.init)&&t.isFunctionExpression(target.path.node.init.callee)){
      names[p.node.name]='utf8Fallback';fallback=target.path.get('init.callee');
    }
  }});
  if(canonical(binding.path.node,names)!==bridgeSignature||!fallback)return false;
  // This fallback is only used for ASCII candidates. Verify its exact byte
  // loop, conversion and cache below, rather than executing an environment.
  const expected=parse(`function factory(){var t=new ArrayAlias(128),n=StringAlias.fromCodePoint||StringAlias.fromCharCode,e=[];return function(g){var r,i,o=g.length;e.length=0;for(var a=0;a<o;)(i=g[a++])<=127?r=i:i<=223?r=(31&i)<<6|63&g[a++]:i<=239?r=(15&i)<<12|(63&g[a++])<<6|63&g[a++]:StringAlias.fromCodePoint?r=(7&i)<<18|(63&g[a++])<<12|(63&g[a++])<<6|63&g[a++]:(r=63,a+=3),e.push(t[r]||(t[r]=n(r)));return e.join("");};}`).program.body[0];
  const fn=t.functionDeclaration(t.identifier('factory'),[],t.cloneNode(fallback.node.body,true)),aliases={};
  fallback.traverse({ReferencedIdentifier(p){const target=p.scope.getBinding(p.node.name);if(target?.constant&&target.path.isVariableDeclarator()){
    const init=target.path.node.init;if(t.isLogicalExpression(init,{operator:'||'})&&t.isMemberExpression(init.left)&&t.isIdentifier(init.right)&&['String','Array'].includes(init.right.name)&&field(init.left)===init.right.name&&!target.path.scope.getBinding(init.right.name)&&nativeNamespace(init.left.object,target.path.scope))aliases[p.node.name]=init.right.name+'Alias';
  }}});
  return canonical(fn,aliases)===canonical(expected);
}
export function base91Decoder(binding){
  if(!binding)return null;
  let declaration=binding.path;
  if(!binding.constant&&binding.constantViolations.some(p=>p.node!==declaration.node)){
    const owner=declaration.parentPath;
    if(!declaration.isFunctionDeclaration()||!owner.isBlockStatement()||!owner.parentPath.isFunction()||binding.constantViolations.some(p=>!p.isFunctionDeclaration()||p.parentPath!==owner))return null;
    declaration=[declaration,...binding.constantViolations].sort((a,b)=>a.node.start-b.node.start).at(-1);
  }
  const fnPath=declaration.isVariableDeclarator()?declaration.get('init'):declaration;
  if(!fnPath.isFunction()||fnPath.node.params.length!==1||fnPath.node.async||fnPath.node.generator)return null;
  const original=fnPath.node;
  const clone=t.functionDeclaration(t.identifier('decode'),original.params.map(n=>t.cloneNode(n)),t.cloneNode(original.body,true)),last=clone.body.body.at(-1);
  if(!t.isReturnStatement(last)||!t.isSequenceExpression(last.argument)||last.argument.expressions.length!==2)return null;
  const call=last.argument.expressions.at(-1);
  if(!t.isCallExpression(call)||!t.isIdentifier(call.callee)||call.arguments.length!==1||!t.isIdentifier(call.arguments[0]))return null;
  if(!utf8Bridge(fnPath.scope.getBinding(call.callee.name)))return null;
  last.argument.expressions[1]=call.arguments[0];let alphabet;
  t.traverseFast(clone,node=>{if(t.isStringLiteral(node)&&node.value.length===91&&new Set(node.value).size===91){alphabet=node.value;node.value='ALPHABET';}});
  if(!alphabet||canonical(clone)!==bytesSignature)return null;
  return text=>{
    let pending=-1,bits=0,buffer=0;const bytes=[];
    for(const character of text){const value=alphabet.indexOf(character);if(value<0)continue;
      if(pending<0){pending=value;continue;}pending+=91*value;buffer|=pending<<bits;bits+=(pending&8191)>88?13:14;
      do{bytes.push(buffer&255);buffer>>=8;bits-=8;}while(bits>7);pending=-1;
    }
    if(pending>=0)bytes.push((buffer|pending<<bits)&255);
    // Native TextDecoder/Buffer and the recognized fallback agree on ASCII.
    // Non-ASCII environment-dependent decoding is deliberately left intact.
    return bytes.every(byte=>byte<128)?String.fromCharCode(...bytes):UNKNOWN_HELPER;
  };
}
function member(n,object,index){return t.isMemberExpression(n)&&n.computed&&t.isIdentifier(n.object,{name:object})&&t.isNodesEquivalent(n.property,index);}
export function cachedDecoder(p){
  const fn=p.node;if(!t.isBlockStatement(fn.body)||fn.async||fn.generator)return null;
  const ret=fn.body.body.at(-1),conditional=t.isReturnStatement(ret)?t.isSequenceExpression(ret.argument)?ret.argument.expressions.at(-1):ret.argument:null;
  if(!t.isConditionalExpression(conditional))return null;
  const {test,consequent,alternate}=conditional;
  if(!t.isBinaryExpression(test,{operator:'==='})||!t.isUnaryExpression(test.left,{operator:'void'})||!t.isNumericLiteral(test.left.argument,{value:0})||!t.isMemberExpression(test.right)||!t.isIdentifier(test.right.object))return null;
  const cacheName=test.right.object.name;
  const index=test.right.property;
  if(!member(test.right,cacheName,index)||!member(alternate,cacheName,index)||!t.isAssignmentExpression(consequent,{operator:'='})||!member(consequent.left,cacheName,index))return null;
  const call=consequent.right;
  if(!t.isCallExpression(call)||call.arguments.length!==1||!t.isMemberExpression(call.arguments[0])||!t.isIdentifier(call.arguments[0].object)||!member(call.arguments[0],call.arguments[0].object.name,index))return null;
  const table=p.scope.getBinding(call.arguments[0].object.name),cache=p.scope.getBinding(cacheName);
  const decoder=t.isIdentifier(call.callee)?p.scope.getBinding(call.callee.name):t.isFunctionExpression(call.callee)?{constant:true,path:p.get('body.body.'+(fn.body.body.length-1)+'.argument'+(t.isSequenceExpression(ret.argument)?'.expressions.'+(ret.argument.expressions.length-1):'')+'.consequent.right.callee')}:null;
  const binding=p.isFunctionDeclaration()?p.parentPath.scope.getBinding(fn.id?.name):p.parentPath.isVariableDeclarator()?p.parentPath.scope.getBinding(p.parentPath.node.id.name):null;
  if(!table?.constant||!cache?.constant||!table.path.isVariableDeclarator()||!cache.path.isVariableDeclarator()||!t.isObjectExpression(cache.path.node.init)||cache.path.node.init.properties.length)return null;
  if(!t.isArrayExpression(table.path.node.init)||!table.path.node.init.elements.every(t.isStringLiteral))return null;
  const base91=base91Decoder(decoder),helper=base91?null:primitiveHelper(decoder);
  if(!base91&&!helper)return null;
  const callable=binding?.constant&&fn.params.length===1&&t.isIdentifier(fn.params[0])&&t.isIdentifier(index,{name:fn.params[0].name})&&fn.body.body.length===1&&conditional===ret.argument;
  const requirements=new Set(helper?.requirements??[]),visited=new Set();
  function dependencies(candidate){
    if(!candidate?.path||visited.has(candidate)||visited.size>80)return;visited.add(candidate);
    const path=candidate.path.isVariableDeclarator()?candidate.path.get('init'):candidate.path;
    path.traverse({ReferencedIdentifier(ref){const target=ref.scope.getBinding(ref.node.name);
      if(!target||target===candidate||path.isFunction()&&target.scope===path.scope||target.path.findParent(parent=>parent===path))return;
      if(target.path.isVariableDeclarator()){requirements.add(target);dependencies(target);}
      else if(target.path.isFunctionDeclaration())dependencies(target);
    }});
  }
  if(base91)dependencies(decoder);
  const contexts=[...visited].map(binding=>binding.path.isVariableDeclarator()?binding.path.get('init'):binding.path);
  const aliases=[...requirements].filter(binding=>{
    const init=binding.path.node.init;return t.isMemberExpression(init)&&['String','Array','TextDecoder','Uint8Array','Buffer'].includes(field(init))||t.isLogicalExpression(init)&&t.isMemberExpression(init.left)&&['String','Array'].includes(field(init.left));
  });
  if(base91&&aliases.some(alias=>alias.referencePaths.some(ref=>!contexts.some(context=>!!ref.findParent(parent=>parent===context)))))return null;
  return {binding:callable?binding:null,path:p,table,cache,decoder,aliases,requirements:[...requirements],decode:base91??(text=>interpretHelper(helper,[text])),kind:base91?'Base91 ASCII/UTF-8':'pure cached helper',values:new Map(),conditional};
}
export function resolveCachedStrings(ast){
  const stats={cachedTables:0,base91Tables:0,cachedDecodedEntries:0,decodedCalls:0,cachePreservedCalls:0,tables:[]},tables=new Map(),records=new Map(),facades=new Map();let unsafe=false;
  // Source code and generated code are never run. Constructor discovery may
  // use the conventional constant "return this" fallback; other generated
  // functions or writes to codec methods make native decoding uncertain.
  const codecs=['String','Array','TextDecoder','Uint8Array','Buffer'],namespaceWrites=[];
  const codecOwner=(node,scope,reference)=>{
    let first=node;while(t.isMemberExpression(first)&&t.isMemberExpression(first.object))first=first.object;
    let key=t.isMemberExpression(first)?field(first):null;
    if(key==null&&t.isMemberExpression(first)&&first.computed&&t.isIdentifier(first.property)){
      const binding=scope.getBinding(first.property.name);if(binding?.constant&&binding.path.isVariableDeclarator()&&reference&&initializedFor(binding,reference)){
        const value=staticValue(binding.path.get('init'));if(value!==UNKNOWN_STATIC&&['string','number','boolean'].includes(typeof value))key=String(value);
      }
    }
    if(t.isMemberExpression(first)&&nativeNamespace(first.object,scope)&&(key==null||codecs.includes(key))){
      // Replacing a global constructor after its private alias was captured
      // cannot change that alias. Mutating its methods/prototype can.
      if(first===node&&reference){namespaceWrites.push(reference);return false;}
      let sensitive=false;t.traverseFast(node,n=>{if(t.isMemberExpression(n)&&n!==first&&(field(n)==null||['prototype','__proto__','indexOf','push','join','fromCharCode','fromCodePoint','decode','toString','from'].includes(field(n))))sensitive=true;});
      return sensitive;
    }
    if(t.isMemberExpression(node)){let prototype=false;t.traverseFast(node.object,n=>{if(t.isMemberExpression(n)&&field(n)==='__proto__')prototype=true;});if(prototype)return true;}
    while(t.isMemberExpression(node))node=node.object;
    if(!t.isIdentifier(node))return false;const binding=scope.getBinding(node.name);
    if(!binding)return codecs.includes(node.name);
    if(!binding.path.isVariableDeclarator())return false;const init=binding.path.node.init;
    return t.isMemberExpression(init)&&codecs.includes(field(init))||t.isLogicalExpression(init)&&t.isIdentifier(init.right)&&codecs.includes(init.right.name);
  };
  traverse(ast,{'CallExpression|NewExpression'(p){if(t.isIdentifier(p.node.callee,{name:'Function'})&&!(p.node.arguments.length===1&&t.isStringLiteral(p.node.arguments[0],{value:'return this'})))unsafe=true;},
    ReferencedIdentifier(p){if(!codecs.includes(p.node.name)||p.scope.getBinding(p.node.name))return;
      const owner=p.parentPath,n=owner.node;
      if(owner.isMemberExpression()&&n.object===p.node||(owner.isCallExpression()||owner.isNewExpression())&&n.callee===p.node||owner.isUnaryExpression({operator:'typeof'})||owner.isBinaryExpression({operator:'instanceof'})&&n.right===p.node||owner.isConditionalExpression()&&owner.parentPath.isCallExpression()&&owner.parentPath.node.callee===n||owner.isLogicalExpression({operator:'||'})&&n.right===p.node&&t.isMemberExpression(n.left)&&field(n.left)===p.node.name)return;
      unsafe=true;
    },
    AssignmentExpression(p){const left=p.node.left;if(codecOwner(left,p.scope,p))unsafe='Codec write: '+generate(left,{comments:false}).code;},
    UpdateExpression(p){if(codecOwner(p.node.argument,p.scope,p))unsafe=true;},
    UnaryExpression(p){if(p.node.operator==='delete'&&codecOwner(p.node.argument,p.scope,p))unsafe=true;},
    CallExpression:{exit(p){const c=p.node.callee;if(t.isIdentifier(c,{name:'eval'}))unsafe=true;if(t.isMemberExpression(c)&&['defineProperty','defineProperties','assign','set','setPrototypeOf'].includes(field(c))){
      if(nativeNamespace(p.node.arguments[0],p.scope))namespaceWrites.push(p);
      else if(codecOwner(p.node.arguments[0],p.scope,p)||p.node.arguments.slice(1).some(n=>t.isStringLiteral(n)&&['indexOf','fromCharCode','fromCodePoint','TextDecoder','Uint8Array','Buffer','decode','toString'].includes(n.value)))unsafe=true;
    }}}
  });
  if(unsafe){stats.skipped=String(unsafe);return stats;}
  const nativeUncertain=staticSafety(ast).intrinsicsChanged;
  traverse(ast,{WithStatement(p){p.skip();},Function(p){const table=cachedDecoder(p);if(table)records.set(p.node,table);}});
  for(const table of records.values()){
    if(!table.binding)continue;
    if(table.kind.startsWith('Base91')&&namespaceWrites.length){
      const aliases=table.aliases;
      if(aliases.length<5||namespaceWrites.some(write=>aliases.some(alias=>!initializedFor(alias,write))))continue;
    }
    const privateData=[table.table,table.cache].every(target=>target.referencePaths.every(ref=>{
      const owner=records.get(ref.getFunctionParent()?.node);return owner&&owner.table===table.table&&owner.cache===table.cache&&!!ref.findParent(parent=>parent.node===owner.conditional);
    }));
    if(privateData&&(!nativeUncertain||table.kind.startsWith('Base91'))){table.shared=nativeUncertain||[...records.values()].filter(other=>other.cache===table.cache).length>1;tables.set(table.binding,table);}
  }
  stats.cachedTables=tables.size;stats.base91Tables=[...tables.values()].filter(table=>table.kind.startsWith('Base91')).length;
  traverse(ast,{WithStatement(p){p.skip();},CallExpression:{exit(p){if(!t.isIdentifier(p.node.callee)||p.node.arguments.length!==1)return;
    const table=tables.get(p.scope.getBinding(p.node.callee.name));if(!table||!initializedFor(table.table,p)||!initializedFor(table.cache,p)||!table.requirements.every(binding=>initializedFor(binding,p)))return;
    const available=binding=>binding?.path.isVariableDeclarator()?initializedFor(binding,p):binding?.path.isFunctionDeclaration()&&(binding.path.parentPath.isProgram()||binding.path.parentPath.isBlockStatement()&&binding.path.parentPath.parentPath.isFunction()&&binding.path.parentPath.key==='body'||binding.path.parentPath.isBlockStatement()&&binding.path.parentPath.parentPath.isTryStatement()&&binding.path.parentPath.key==='block'&&binding.path.node.end<p.node.start&&!!p.findParent(parent=>parent===binding.path.parentPath));
    const inlineDecoder=table.decoder?.path.isFunctionExpression()&&!!table.decoder.path.findParent(parent=>parent===table.path);
    if(!available(table.binding)||!inlineDecoder&&!available(table.decoder))return;
    const index=staticValue(p.get('arguments.0'));if(index===UNKNOWN_STATIC||!Number.isInteger(index)||index<0||index>=table.table.path.node.init.elements.length)return;
    if(!table.values.has(index)){let value;try{value=table.decode(table.table.path.node.init.elements[index].value);}catch{value=UNKNOWN_HELPER;}table.values.set(index,value);}
    const value=table.values.get(index);if(typeof value!=='string')return;
    if(table.shared){
      // Different alphabets can share a cache. Retain its runtime result and
      // first-write behavior; a literal replacement would be incorrect.
      let name=facades.get(table.cache);
      if(!name){
        const owner=table.cache.path.getFunctionParent(),container=owner?.isFunction()&&t.isBlockStatement(owner.node.body)?owner.get('body'):table.cache.scope.path.isProgram()?table.cache.scope.path:null;
        if(!container)return;
        name=table.cache.scope.generateUidIdentifier('readDecodedString');facades.set(table.cache,name);
        const lookup=t.memberExpression(t.identifier(table.cache.identifier.name),t.identifier('index'),true);
        const helper=t.functionDeclaration(t.cloneNode(name),[t.identifier('index'),t.identifier('decodedText')],t.blockStatement([
          t.returnStatement(t.conditionalExpression(t.binaryExpression('===',t.unaryExpression('void',t.numericLiteral(0)),t.cloneNode(lookup)),t.assignmentExpression('=',t.cloneNode(lookup),t.identifier('decodedText')),t.cloneNode(lookup)))
        ]));
        container.unshiftContainer('body',helper);
      }
      p.replaceWith(t.callExpression(t.cloneNode(name),[t.numericLiteral(index),t.stringLiteral(value)]));stats.cachePreservedCalls++;
    }else p.replaceWith(t.stringLiteral(value));stats.decodedCalls++;
  }}});
  for(const table of tables.values()){const decoded=[...table.values].filter(([,value])=>typeof value==='string');stats.cachedDecodedEntries+=decoded.length;
    stats.tables.push({decoder:table.binding.identifier.name,kind:table.kind,sharedCache:table.shared,entries:table.table.path.node.init.elements.length,decoded:decoded.map(([index,value])=>({index,value}))});}
  return stats;
}
