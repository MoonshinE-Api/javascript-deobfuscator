import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {primitiveLiteral,UNKNOWN_LITERAL} from './clean-junk.js';
import {valueNode} from './static-values.js';
import {initializedFor} from './initialized-binding.js';
import {dynamicBindings} from './dynamic-scope.js';
import {staticSafety} from './static-safety.js';
const traverse=traverseModule.default??traverseModule;
const available=(binding,p)=>binding?.path.isVariableDeclarator()?initializedFor(binding,p):binding?.path.isFunctionDeclaration()&&(binding.path.parentPath.isProgram()||binding.path.parentPath.isBlockStatement()&&binding.path.parentPath.parentPath.isFunction()&&binding.path.parentPath.key==='body');
// Decode layers often reorder/offset constant arguments. Substitute AST nodes,
// never source text; retain wrapper declarations for identity/name observers.
export function decoderWrappers(ast,{passes=8}={}){
 const stats={inlinedCalls:0,passes:0};if(staticSafety(ast).directEval)return stats;
 let reflection=false;
 traverse(ast,{MemberExpression(p){const n=p.node,key=n.computed&&t.isStringLiteral(n.property)?n.property.value:!n.computed?n.property.name:null;if(['caller','callee','stack'].includes(key))reflection=true;}});
 if(reflection)return stats;
 const protectedBindings=dynamicBindings(ast);
 for(let round=0;round<passes;round++){
  let changes=0;stats.passes++;
  traverse(ast,{WithStatement(p){p.skip();},CallExpression:{exit(p){
   if(!t.isIdentifier(p.node.callee))return;
   const binding=p.scope.getBinding(p.node.callee.name);
   if(!binding?.constant||protectedBindings.has(binding)||!available(binding,p))return;
   const fn=binding.path.isVariableDeclarator()?binding.path.get('init'):binding.path;
   if(!fn.isFunction()||fn.node.async||fn.node.generator||!t.isBlockStatement(fn.node.body)||fn.node.body.directives.length||fn.node.body.body.length!==1||!fn.node.params.every(t.isIdentifier))return;
   const ret=fn.node.body.body[0],call=t.isReturnStatement(ret)?ret.argument:null;
   if(!t.isCallExpression(call)||!t.isIdentifier(call.callee)||call.optional||call.arguments.some(t.isSpreadElement)||p.node.arguments.length!==fn.node.params.length)return;
   const target=fn.scope.getBinding(call.callee.name);
   if(!target?.constant||target===binding||protectedBindings.has(target)||p.scope.getBinding(call.callee.name)!==target||!available(target,p))return;
   const targetFn=target.path.isVariableDeclarator()?target.path.get('init'):target.path;
   if(!targetFn.isFunction())return;
   const values=p.node.arguments.map(n=>primitiveLiteral(n));
   if(values.some(v=>v===UNKNOWN_LITERAL)||new Set(fn.node.params.map(n=>n.name)).size!==fn.node.params.length)return;
   const substitutions=new Map(fn.node.params.map((n,i)=>[n.name,valueNode(values[i])])),out=[];
   for(const arg of call.arguments){
    let valid=true;
    const substitute=n=>{
     if(t.isIdentifier(n)){if(!substitutions.has(n.name)){valid=false;return n;}return t.cloneNode(substitutions.get(n.name),true);}
     if(!(t.isLiteral(n)||t.isUnaryExpression(n)&&['!','+','-','~','void','typeof'].includes(n.operator)||t.isBinaryExpression(n)||t.isLogicalExpression(n)||t.isConditionalExpression(n))){valid=false;return n;}
     const copy=t.cloneNode(n,true);for(const key of t.VISITOR_KEYS[n.type]??[])if(n[key])copy[key]=substitute(n[key]);return copy;
    };
    const expression=substitute(arg),value=valid?primitiveLiteral(expression):UNKNOWN_LITERAL;
    if(value===UNKNOWN_LITERAL)return;out.push(valueNode(value));
   }
   p.replaceWith(t.callExpression(t.cloneNode(call.callee),out));changes++;stats.inlinedCalls++;
  }}});
  if(!changes)break;
 }
 return stats;
}
