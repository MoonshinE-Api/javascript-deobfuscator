import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule;
const ignored=new Set(['start','end','loc','extra','leadingComments','trailingComments','innerComments','comments','tokens','errors','_compact']);
function structure(value){
  if(Array.isArray(value))return value.map(structure);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!ignored.has(key)).map(([key,val])=>[key,structure(val)]));
  return value;
}
// Change layout only. Never delete a module or infer that unobserved code is dead.
export function fullReadable(source,{compact=false}={}){
  let ast=parse(source,{sourceType:'unambiguous'});const before=JSON.stringify(structure(ast));let compactBlocks=0,compactGuards=0,compactObjects=0,compactCases=0,compactCalls=0,packedDataTables=0;
  const short=n=>{const text=generate(n,{concise:true,comments:true}).code;return text.length<=180&&!text.includes('\n')&&!/\/\//.test(text);};
  if(compact)traverse(ast,{noScope:true,BlockStatement:{exit(p){
    if(p.node.body.length>5||p.node.directives.length||p.node.body.some(n=>/^(If|For|While|DoWhile|Switch|Try)/.test(n.type)))return;
    const text=generate(p.node,{concise:true,comments:true}).code;
    if(text.length<=180&&!text.includes('\n')&&!/\/\//.test(text)){p.node._compact=true;compactBlocks++;}
  }},IfStatement:{exit(p){if(short(p.node)){p.node._compact=true;compactGuards++;}}},ObjectExpression:{exit(p){if(p.node.properties.length<=12&&short(p.node)){p.node._compact=true;compactObjects++;}}},SwitchCase:{exit(p){if(p.node.consequent.length<=6&&short(p.node)){p.node._compact=true;compactCases++;}}},'CallExpression|NewExpression':{exit(p){if(p.node.arguments.length<=4&&short(p.node)){p.node._compact=true;compactCalls++;}}}});
  let body=generate(ast,{comments:true,jsescOption:{minimal:true}}).code;
  ast=null;traverse.cache.clear();globalThis.gc?.();
  // Put literal lookup tables in readable rows instead of one value per line.
  // Keep executable expressions, holes and commented entries in their usual layout.
  const edits=[];
  traverse(parse(body,{sourceType:'unambiguous'}),{noScope:true,ArrayExpression(p){
    if(p.node.elements.length<8||p.node.leadingComments||p.node.innerComments||p.node.trailingComments)return;
    if(!p.node.elements.every(n=>n&&!n.leadingComments&&!n.trailingComments&&!n.innerComments&&(t.isNumericLiteral(n)||t.isStringLiteral(n)||t.isBooleanLiteral(n)||t.isNullLiteral(n)||t.isUnaryExpression(n,{operator:'-'})&&t.isNumericLiteral(n.argument))))return;
    const lineStart=body.lastIndexOf('\n',p.node.start)+1,indent=body.slice(lineStart,p.node.start).match(/^\s*/)[0],rows=[];let row='';
    for(const n of p.node.elements){const value=generate(n,{comments:false,jsescOption:{minimal:true}}).code;if(row&&indent.length+row.length+value.length+4>120){rows.push(row);row='';}row+=(row?' ':'')+value+',';}
    if(row)rows.push(row);rows[rows.length-1]=rows.at(-1).replace(/,$/,'');
    const text='[\n'+rows.map(r=>indent+'  '+r).join('\n')+'\n'+indent+']';
    const previous=body.slice(p.node.start,p.node.end);
    if(text.split('\n').length<previous.split('\n').length||previous.split('\n').some(line=>line.length>120)){edits.push({start:p.node.start,end:p.node.end,text});packedDataTables++;}
  }});
  for(const edit of edits.sort((a,b)=>b.start-a.start))body=body.slice(0,edit.start)+edit.text+body.slice(edit.end);
  traverse.cache.clear();globalThis.gc?.();
  const code='// Complete cleaned program. Statements use expanded layout; literal tables use readable rows.\n'+body+'\n';
  const after=JSON.stringify(structure(parse(code,{sourceType:'unambiguous'})));
  if(before!==after)throw new Error('Full readable layout changed the parsed program; refusing to write it.');
  return {code,stats:{inputLines:source.trimEnd().split('\n').length,outputLines:code.trimEnd().split('\n').length,compactBlocks,compactGuards,compactObjects,compactCases,compactCalls,packedDataTables,
    bytes:Buffer.byteLength(code),validation:'Parsed structure matches the complete cleaned program. This is not a proof of equivalence to the original obfuscated input.'}};
}
