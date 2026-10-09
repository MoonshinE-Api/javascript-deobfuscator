import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
import { initializedFor } from './initialized-binding.js';
import {primitiveLiteral,UNKNOWN_LITERAL} from './clean-junk.js';
import {dynamicBindings} from './dynamic-scope.js';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule;

// No calls, getters, coercion of objects, spreads, or arbitrary input execution.
function harmless(n,depth=0){
 if(!n||depth>60)return !n;
 if(primitiveLiteral(n)!==UNKNOWN_LITERAL)return true;
 if(t.isFunctionExpression(n)||t.isArrowFunctionExpression(n))return true;
 if(t.isArrayExpression(n))return n.elements.every(v=>!v||!t.isSpreadElement(v)&&harmless(v,depth+1));
 if(t.isObjectExpression(n))return n.properties.every(p=>!p.computed&&!t.isSpreadElement(p)&&(t.isObjectMethod(p)||t.isObjectProperty(p)&&harmless(p.value,depth+1)));
 if(t.isSequenceExpression(n))return n.expressions.every(v=>harmless(v,depth+1));
 if(t.isUnaryExpression(n)&&['void','typeof','!'].includes(n.operator))return harmless(n.argument,depth+1);
 if(t.isBinaryExpression(n)&&['===','!=='].includes(n.operator))return harmless(n.left,depth+1)&&harmless(n.right,depth+1);
 if(t.isLogicalExpression(n))return harmless(n.left,depth+1)&&harmless(n.right,depth+1);
 if(t.isConditionalExpression(n))return harmless(n.test,depth+1)&&harmless(n.consequent,depth+1)&&harmless(n.alternate,depth+1);
 return false;
}
function literalNode(value){
 if(typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0))||typeof value==='string'&&value.length>8192)return null;
 return value===undefined?t.unaryExpression('void',t.numericLiteral(0)):t.valueToNode(value);
}
const within=(ref,owner)=>ref===owner||!!ref.findParent(p=>p===owner);
function dynamicScopes(ast){
 const unsafe=new Set();const mark=p=>{for(let s=p.scope;s;s=s.parent)unsafe.add(s);};
 traverse(ast,{CallExpression(p){if(t.isIdentifier(p.node.callee,{name:'eval'}))mark(p);}});return unsafe;
}
const inWith=p=>!!p.findParent(q=>q.isWithStatement());
function selfOnly(binding,p){return binding.referencePaths.every(ref=>within(ref,p));}

// Inline only immutable LOCAL helpers with primitive arguments and a return
// made solely of their own parameters and literal arithmetic. Never execute it.
function helperValue(fn,args){
 if(args.some(a=>t.isSpreadElement(a)||primitiveLiteral(a)===UNKNOWN_LITERAL)||fn.params.some(p=>!t.isIdentifier(p))||new Set(fn.params.map(p=>p.name)).size!==fn.params.length)return UNKNOWN_LITERAL;
 const expression=t.isBlockStatement(fn.body)?fn.body.body.length===1&&t.isReturnStatement(fn.body.body[0])?fn.body.body[0].argument:null:fn.body;
 if(!expression)return UNKNOWN_LITERAL;const parameters=new Map(fn.params.map((p,i)=>[p.name,args[i]??t.unaryExpression('void',t.numericLiteral(0))]));
 function substitute(n,depth=0){
  if(!n||depth>40)return null;
  if(t.isIdentifier(n))return parameters.has(n.name)?t.cloneNode(parameters.get(n.name),true):null;
  if(t.isNumericLiteral(n)||t.isStringLiteral(n)||t.isBooleanLiteral(n)||t.isNullLiteral(n))return t.cloneNode(n);
  if(t.isUnaryExpression(n)&&n.operator!=='delete'){const a=substitute(n.argument,depth+1);return a?t.unaryExpression(n.operator,a,n.prefix):null;}
  if(t.isBinaryExpression(n)||t.isLogicalExpression(n)){const a=substitute(n.left,depth+1),b=substitute(n.right,depth+1);return a&&b?(t.isBinaryExpression(n)?t.binaryExpression(n.operator,a,b):t.logicalExpression(n.operator,a,b)):null;}
  if(t.isConditionalExpression(n)){const a=substitute(n.test,depth+1),b=substitute(n.consequent,depth+1),c=substitute(n.alternate,depth+1);return a&&b&&c?t.conditionalExpression(a,b,c):null;}
  return null;
 }
 const substituted=substitute(expression);return substituted?primitiveLiteral(substituted):UNKNOWN_LITERAL;
}

export function shrink(source,{rounds=4,ast:existingAst}={}){
 if(!Number.isInteger(rounds)||rounds<1||rounds>12)throw new Error('Shrink rounds must be 1–12');
 const ast=existingAst??parse(source,{sourceType:'unambiguous'}),stats={passes:0,foldedExpressions:0,foldedHelperCalls:0,removedStatements:0,removedBindings:0,removedFunctions:0,removedDeadWrites:0,removedUnreachable:0,flattenedBlocks:0,skippedDynamicBindings:0};
 for(let round=0;round<rounds;round++){
  traverse(ast,{Program(p){p.scope.crawl();p.stop();}});const unsafe=dynamicScopes(ast),unsafeBindings=dynamicBindings(ast),before=JSON.stringify({...stats,passes:0,skippedDynamicBindings:0});
  const allowed=p=>!inWith(p)&&!unsafe.has(p.getFunctionParent()?.scope??p.scope.getProgramParent());
  traverse(ast,{
   CallExpression:{exit(p){
    if(!allowed(p)||!t.isIdentifier(p.node.callee))return;const binding=p.scope.getBinding(p.node.callee.name);
    if(!binding?.constant||binding.scope.path.isProgram()||unsafe.has(binding.scope)||unsafeBindings.has(binding))return;
    let fn;
    if(binding.path.isFunctionDeclaration())fn=binding.path.node;
    else if(binding.path.isVariableDeclarator()&&t.isFunction(binding.path.node.init)&&binding.path.node.end<p.node.start&&binding.path.getFunctionParent()===p.getFunctionParent())fn=binding.path.node.init;
    if(!fn||fn.async||fn.generator||binding.referencePaths.some(ref=>!ref.parentPath.isCallExpression()||ref.parentPath.node.callee!==ref.node))return;
    const value=helperValue(fn,p.node.arguments),node=value===UNKNOWN_LITERAL?null:literalNode(value);if(node){t.inheritsComments(node,p.node);p.replaceWith(node);stats.foldedHelperCalls++;}
   }},
   'BinaryExpression|UnaryExpression|LogicalExpression|ConditionalExpression':{exit(p){
    if(!allowed(p))return;const value=primitiveLiteral(p.node),node=value===UNKNOWN_LITERAL?null:literalNode(value);if(node&&!t.isNodesEquivalent(node,p.node)){t.inheritsComments(node,p.node);p.replaceWith(node);stats.foldedExpressions++;}
   }},
   ExpressionStatement:{exit(p){
    if(!p.getFunctionParent()||!p.inList||!allowed(p)||!harmless(p.node.expression))return;
    p.remove();stats.removedStatements++;
   }},
   BlockStatement:{exit(p){
    if(!allowed(p))return;const paths=p.get('body');let stopped=false;
    for(const child of paths){if(!child.node)continue;
     if(!stopped){if(child.isReturnStatement()||child.isThrowStatement()||child.isBreakStatement()||child.isContinueStatement())stopped=true;continue;}
     // Preserve declarations: var/function hoisting and lexical TDZ can be
     // observable even when their initialization is unreachable.
     if(child.isExpressionStatement()||child.isEmptyStatement()||child.isReturnStatement()||child.isThrowStatement()||child.isBreakStatement()||child.isContinueStatement()){child.remove();stats.removedUnreachable++;}
    }
    if(p.inList&&!p.node.directives.length&&p.node.body.every(n=>!t.isFunctionDeclaration(n)&&!t.isClassDeclaration(n)
      &&!(t.isVariableDeclaration(n)&&n.kind!=='var')&&!(t.isExpressionStatement(n)&&t.isStringLiteral(n.expression)))) {
      p.replaceWithMultiple(p.node.body);
      stats.flattenedBlocks++;
    }
   }}
  });
  traverse(ast,{Program(p){p.scope.crawl();p.stop();}});
  // Remove local declarations only after reference information was rebuilt.
  traverse(ast,{
   VariableDeclarator(p){
    if(!t.isIdentifier(p.node.id)||!p.getFunctionParent()||!p.parentPath.inList||!p.parentPath.parentPath.isBlockStatement()||inWith(p))return;
    const declaration=p.parentPath,binding=p.scope.getBinding(p.node.id.name);
    const init=p.node.init, sourceBinding=t.isIdentifier(init)?p.scope.getBinding(init.name):null;
    const safeAlias=sourceBinding && (sourceBinding.path.isFunctionDeclaration()
      || sourceBinding.constant && initializedFor(sourceBinding,p));
    if(!binding||binding.path!==p||binding.referenced||!harmless(init)&&!safeAlias)return;
    if(unsafe.has(binding.scope)||unsafeBindings.has(binding)){stats.skippedDynamicBindings++;return;}
    const writes=binding.constantViolations;
    if(writes.length&&(declaration.node.kind==='const'||writes.some(w=>!w.isAssignmentExpression({operator:'='})||!t.isIdentifier(w.node.left,{name:p.node.id.name})||!harmless(w.node.right)||!w.parentPath.isExpressionStatement()||!w.parentPath.inList||w.parentPath.parentPath!==declaration.parentPath||inWith(w)||declaration.node.kind!=='var'&&w.node.start<p.node.end)))return;
    for(const write of writes){write.parentPath.remove();stats.removedDeadWrites++;}
    p.remove();if(declaration.node&&declaration.node.declarations.length===0&&!declaration.removed)declaration.remove();stats.removedBindings++;
   },
   FunctionDeclaration(p){
    const owner=p.getFunctionParent();if(!owner||p.parentPath!==owner.get('body')||!p.node.id||inWith(p))return;
    const binding=p.parentPath.scope.getBinding(p.node.id.name);if(!binding||binding.path!==p||binding.constantViolations.length||unsafe.has(binding.scope)||!selfOnly(binding,p))return;
    p.remove();stats.removedFunctions++;
   }
  });
  stats.passes++;if(before===JSON.stringify({...stats,passes:0,skippedDynamicBindings:0}))break;
 }
 // The shared pipeline owns generation and final parsing. Avoid creating two
 // full extra trees merely to collect cleanup counts on its existing AST.
 if(existingAst)return {stats};
 const code=generate(ast,{comments:true,jsescOption:{minimal:true}}).code+'\n';parse(code,{sourceType:'unambiguous'});
 return {code,stats};
}
