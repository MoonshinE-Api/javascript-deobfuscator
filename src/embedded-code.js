import {createHash} from 'node:crypto';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {staticValue,UNKNOWN_STATIC} from './static-values.js';
import {staticSafety} from './static-safety.js';
import {initializedFor} from './initialized-binding.js';
import {primitiveLiteral} from './clean-junk.js';
const traverse=traverseModule.default??traverseModule;
const targets=new Set(['eval','Function','setTimeout','setInterval']);
export function extractEmbeddedCode(source,{maxPayloads=32,maxBytes=1024*1024}={}){
  const ast=parse(source,{sourceType:'unambiguous'}),safety=staticSafety(ast,{ignoreDynamicCode:true});
  const payloads=[],unresolved=[],dedup=new Map();let candidates=0,bytes=0,priorDynamic=false;
  traverse(ast,{'CallExpression|NewExpression'(p){
    let callee=p.node.callee;
    if(t.isSequenceExpression(callee)&&callee.expressions.length===2&&t.isNumericLiteral(callee.expressions[0],{value:0}))callee=callee.expressions[1];
    let kind=t.isIdentifier(callee)&&!p.scope.getBinding(callee.name)?callee.name:null;
    if(t.isMemberExpression(callee)&&t.isIdentifier(callee.object)&&['globalThis','window','self'].includes(callee.object.name)&&!p.scope.getBinding(callee.object.name))kind=callee.computed?t.isStringLiteral(callee.property)?callee.property.value:null:callee.property.name;
    if(!targets.has(kind)||!p.node.arguments.length)return;
    candidates++;const site={kind,line:p.node.loc.start.line,column:p.node.loc.start.column+1};
    // Values from a dynamically mutable scope are left unresolved. Closed
    // literal native chains can still be inspected without evaluating eval.
    const values=p.get('arguments').map(arg=>{
      const direct=primitiveString(arg);if(direct!==UNKNOWN_STATIC)return direct;
      return safety.intrinsicsChanged||priorDynamic?UNKNOWN_STATIC:staticValue(arg,{bindings:!safety.dynamic&&!safety.globalWrites});
    });
    priorDynamic=true;
    const body=kind==='Function'?values.at(-1):values[0],params=kind==='Function'?values.slice(0,-1):[];
    if(typeof body!=='string'||params.some(value=>typeof value!=='string')){
      if(unresolved.length<64)unresolved.push({...site,reason:typeof body==='string'?'Extraction budget or parameters unavailable':'String is not a supported static expression'});return;
    }
    const code=kind==='Function'?`function extractedFunction(${params.join(',')}) {\n${body}\n}`:body;
    const sha256=createHash('sha256').update(code).digest('hex');
    if(dedup.has(sha256)){dedup.get(sha256).sites.push(site);return;}
    const payloadBytes=Buffer.byteLength(code);
    if(payloads.length>=maxPayloads||bytes+payloadBytes>maxBytes){
      if(unresolved.length<64)unresolved.push({...site,reason:'Extraction budget exhausted'});return;
    }
    const record={id:payloads.length+1,sha256,kind,parameters:params,raw:body,code,sites:[site],syntaxError:null};
    try{parse(code,{sourceType:'unambiguous'});}catch(error){record.syntaxError=error.message;}
    bytes+=payloadBytes;payloads.push(record);dedup.set(sha256,record);
  }});
  return {stats:{candidates,extracted:payloads.length,unresolved:candidates-payloads.reduce((n,payload)=>n+payload.sites.length,0),bytes},payloads,unresolved,
    scope:'Static string candidates saved for inspection. Input and payloads are never executed. Function bodies use a synthetic wrapper for readable analysis; execution context and coverage are not inferred.'};
}
function primitiveString(p){
  const value=primitiveLiteral(p.node);if(typeof value==='string')return value;
  if(p.isIdentifier()){
    const binding=p.scope.getBinding(p.node.name);
    if(binding?.constant&&binding.path.isVariableDeclarator()&&binding.path.parentPath.node.kind==='const'&&initializedFor(binding,p)){
      const value=primitiveLiteral(binding.path.node.init);if(typeof value==='string')return value;
    }
  }
  return UNKNOWN_STATIC;
}
