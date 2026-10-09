import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import { initializedFor } from './initialized-binding.js';
import { primitiveHelper, interpretHelper, UNKNOWN_HELPER } from './primitive-helpers.js';
import { primitiveLiteral, UNKNOWN_LITERAL } from './clean-junk.js';
import {staticSafety} from './static-safety.js';
import {nativeCall,nativeStatic,nativeMethod,UNKNOWN_NATIVE,boundedValue} from './native-values.js';
import {constantSwitch,constantLoop} from './control-cleanup.js';
import {valueNode} from './static-values.js';
import {dynamicBindings} from './dynamic-scope.js';
const traverse = traverseModule.default ?? traverseModule;
const UNKNOWN = Symbol('unknown');
const atom = value => value === null || ['string','number','boolean'].includes(typeof value);
const replaceable = value => atom(value) && !(typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0)));
const maxLength = 100_000;
const key = node => t.isIdentifier(node) ? node.name : t.isStringLiteral(node) || t.isNumericLiteral(node) ? String(node.value) : null;

function literal(node, scope, depth = 0) {
  if (!node || depth > 40) return UNKNOWN;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isUnaryExpression(node,{operator:'-'}) && t.isNumericLiteral(node.argument)) return -node.argument.value;
  const value=primitiveLiteral(node);if(value!==UNKNOWN_LITERAL)return value;
  if (t.isArrayExpression(node) && node.elements.length <= 10_000) {
    const values=node.elements.map(child=>literal(child,scope,depth+1));
    if (values.every(atom)) return values;
  }
  return UNKNOWN;
}

function bounded(value) {
  return atom(value) ? typeof value!=='string'||value.length<=maxLength
    : Array.isArray(value) && value.length<=10_000 && value.every(atom) && value.reduce((size,item)=>size+String(item).length,0)<=maxLength;
}

function staticCall(p, intrinsicsChanged) {
  if (intrinsicsChanged || p.node.arguments.some(arg=>t.isSpreadElement(arg))) return UNKNOWN;
  const args=p.node.arguments.map(arg=>literal(arg,p.scope));
  if (args.some(value=>value===UNKNOWN||!bounded(value))||args.length>10_000
    ||args.reduce((size,value)=>size+(Array.isArray(value)?value.reduce((n,v)=>n+String(v).length,0):String(value).length),0)>maxLength) return UNKNOWN;
  const callee=p.node.callee;
  try {
    const result=value=>value===UNKNOWN_NATIVE?UNKNOWN:value;
    if(t.isIdentifier(callee)&&!p.scope.getBinding(callee.name))return result(nativeCall(callee.name,args));
    if (!t.isMemberExpression(callee) || callee.optional) return UNKNOWN;
    const method=callee.computed && t.isStringLiteral(callee.property) ? callee.property.value : !callee.computed ? key(callee.property) : null;
    if(t.isIdentifier(callee.object)&&!p.scope.getBinding(callee.object.name)){
      const value=nativeStatic(callee.object.name,method,args);if(value!==UNKNOWN_NATIVE)return value;
    }
    const receiver=literal(callee.object,p.scope);
    if(receiver!==UNKNOWN&&!bounded(receiver))return UNKNOWN;
    if(receiver!==UNKNOWN)return result(nativeMethod(Array.isArray(receiver)?receiver.slice():receiver,method,args,{mutable:Array.isArray(receiver)}));
  } catch { /* Invalid encoding or unsupported native arguments stay intact. */ }
  return UNKNOWN;
}

function isWrite(p) {
  let current=p;
  while(current.parentPath){const parent=current.parentPath;
    if(parent.isAssignmentExpression())return parent.node.left===current.node;
    if(parent.isUpdateExpression()||parent.isUnaryExpression({operator:'delete'}))return true;
    if(parent.isForInStatement()||parent.isForOfStatement())return parent.node.left===current.node;
    if(parent.isObjectProperty()||parent.isObjectPattern()||parent.isArrayPattern()||parent.isRestElement()||parent.isAssignmentPattern())current=parent;
    else return false;
  }return false;
}

function readonlyLookup(binding) {
  return binding?.constant && binding.path.isVariableDeclarator() && binding.referencePaths.every(ref=>{
    const member=ref.parentPath;
    return member.isMemberExpression() && member.node.object===ref.node && !isWrite(member);
  });
}

function unconditionalDeclaration(binding) {
  if(!binding?.path.isVariableDeclarator())return false;
  const declaration=binding.path.parentPath,container=declaration.parentPath;
  return declaration.isVariableDeclaration() && (container.isProgram()
    ||container.isBlockStatement()&&container.parentPath.isFunction()&&container.key==='body');
}

function proxyTable(binding) {
  if(!readonlyLookup(binding)||!unconditionalDeclaration(binding)||!t.isObjectExpression(binding.path.node.init))return null;
  const entries=new Map();
  for(const prop of binding.path.node.init.properties){
    if(!t.isObjectProperty(prop)||prop.computed||key(prop.key)==='__proto__'||entries.has(key(prop.key)))return null;
    const value=literal(prop.value,binding.scope);
    if(value!==UNKNOWN && replaceable(value))entries.set(key(prop.key),{value});
    else if(t.isFunctionExpression(prop.value) && !prop.value.async && !prop.value.generator
      && prop.value.params.every(param=>t.isIdentifier(param)) && prop.value.body.directives.length===0
      && prop.value.body.body.length===1 && t.isReturnStatement(prop.value.body.body[0]))entries.set(key(prop.key),{fn:prop.value});
    else return null;
  }
  return entries;
}

function inlineWrapper(fn,args) {
  if(args.length!==fn.params.length || args.some(arg=>t.isSpreadElement(arg)))return null;
  const names=fn.params.map(param=>param.name);let expression=fn.body.body[0].argument;
  if(t.isCallExpression(expression)&&t.isSequenceExpression(expression.callee)
    &&expression.callee.expressions.length===2&&t.isNumericLiteral(expression.callee.expressions[0],{value:0})
    &&t.isIdentifier(expression.callee.expressions[1])) {
    expression=t.cloneNode(expression,true);expression.callee=expression.callee.expressions[1];
  }
  if(!expression||new Set(names).size!==names.length)return null;
  const order=[];
  let valid=true;
  t.traverseFast(expression,node=>{
    if(t.isIdentifier(node)){if(!names.includes(node.name))valid=false;else order.push(node.name);}
    else if(!(t.isBinaryExpression(node)||t.isUnaryExpression(node)&&['!','+','-','~'].includes(node.operator)
      ||t.isLogicalExpression(node)||t.isCallExpression(node)||t.isLiteral(node)))valid=false;
  });
  if(!valid || order.length!==names.length || order.some((name,index)=>name!==names[index]))return null;
  // Compound operations can coerce objects before later arguments are read;
  // short-circuit operations can skip arguments. Only primitives qualify.
  const simpleBinary=t.isBinaryExpression(expression)&&t.isIdentifier(expression.left)&&t.isIdentifier(expression.right);
  const simpleUnary=t.isUnaryExpression(expression)&&t.isIdentifier(expression.argument);
  const forwardCall=t.isCallExpression(expression)&&t.isIdentifier(expression.callee)
    && expression.arguments.every(arg=>t.isIdentifier(arg));
  if(!simpleBinary&&!simpleUnary&&!forwardCall && !args.every(arg=>atom(literal(arg))))return null;
  const substitutions=new Map(names.map((name,index)=>[name,args[index]]));
  function substitute(node){
    if(t.isIdentifier(node))return t.cloneNode(substitutions.get(node.name),true);
    const clone=t.cloneNode(node,false);
    for(const field of t.VISITOR_KEYS[node.type]??[]){const child=node[field];clone[field]=Array.isArray(child)?child.map(substitute):child?substitute(child):child;}
    if(t.isCallExpression(clone))clone.callee=t.sequenceExpression([t.numericLiteral(0),clone.callee]);
    return clone;
  }
  return substitute(expression);
}

function hoists(node) {
  const names=new Set();let unsupported=false;
  function walk(n){if(!n)return;
    if(t.isFunctionDeclaration(n)){unsupported=true;return;}
    if(t.isFunction(n))return;
    if(t.isVariableDeclaration(n) && n.kind==='var')for(const declaration of n.declarations)for(const name of Object.keys(t.getBindingIdentifiers(declaration.id)))names.add(name);
    for(const field of t.VISITOR_KEYS[n.type]??[]){const value=n[field];if(Array.isArray(value))value.forEach(walk);else walk(value);}
  }walk(node);
  return {names:[...names],unsupported};
}
const declarations=names=>names.length?[t.variableDeclaration('var',names.map(name=>t.variableDeclarator(t.identifier(name))))]:[];

function dispatcher(p, globalWrites) {
  const loop=p.node;
  if(p.parentPath.isLabeledStatement())return null;
  if(t.isWhileStatement(loop)){if(!t.isBooleanLiteral(loop.test,{value:true}))return null;}
  else if(!t.isForStatement(loop)||loop.init||loop.update||loop.test&&!t.isBooleanLiteral(loop.test,{value:true}))return null;
  if(!t.isBlockStatement(loop.body)||loop.body.body.length!==2 || !t.isSwitchStatement(loop.body.body[0])
    || !t.isBreakStatement(loop.body.body[1])||loop.body.body[1].label)return null;
  const sw=loop.body.body[0], discriminant=sw.discriminant;
  if(!t.isMemberExpression(discriminant)||!discriminant.computed||!t.isIdentifier(discriminant.object)
    ||!t.isUpdateExpression(discriminant.property,{operator:'++',prefix:false})||!t.isIdentifier(discriminant.property.argument))return null;
  const orderBinding=p.scope.getBinding(discriminant.object.name), counter=p.scope.getBinding(discriminant.property.argument.name);
  if(globalWrites&&(orderBinding?.scope.path.isProgram()||counter?.scope.path.isProgram()))return null;
  if(!readonlyLookup(orderBinding)||orderBinding.referencePaths.length!==1||!counter?.path.isVariableDeclarator()
    ||!unconditionalDeclaration(orderBinding)||!unconditionalDeclaration(counter)
    ||!t.isNumericLiteral(counter.path.node.init,{value:0}) ||counter.constantViolations.some(ref=>ref.node!==discriminant.property))return null;
  if(orderBinding.path.getFunctionParent()!==p.getFunctionParent()||counter.path.getFunctionParent()!==p.getFunctionParent()
    ||orderBinding.path.node.end==null||counter.path.node.end==null||p.node.start==null
    ||orderBinding.path.node.end>=p.node.start||counter.path.node.end>=p.node.start)return null;
  const order=literal(orderBinding.path.node.init,orderBinding.scope);
  if(!Array.isArray(order)||!order.every(value=>['number','string'].includes(typeof value)))return null;
  const cases=new Map();
  for(const entry of sw.cases){
    const value=literal(entry.test,p.scope);if(!['number','string'].includes(typeof value))return null;
    const id=typeof value+':'+value;if(cases.has(id))return null;
    const body=entry.consequent, last=body.at(-1);
    if(!last || !(t.isContinueStatement(last)&&!last.label||t.isReturnStatement(last)||t.isThrowStatement(last)))return null;
    let unsafe=false;
    for(const statement of body){t.traverseFast(statement,node=>{
      if(t.isVariableDeclaration(node)&&node.kind!=='var'||t.isClassDeclaration(node)||t.isFunctionDeclaration(node)
        ||t.isBreakStatement(node)||t.isContinueStatement(node)&&node!==last)unsafe=true;
    });}
    if(unsafe)return null;
    cases.set(id,body);
  }
  if(order.some(value=>!cases.has(typeof value+':'+value))||order.length>1000)return null;
  const collected=hoists(sw);if(collected.unsupported)return null;
  const statements=declarations(collected.names);
  const advance=()=>t.expressionStatement(t.updateExpression('++',t.identifier(counter.identifier.name),false));
  for(const value of order){const body=cases.get(typeof value+':'+value);statements.push(advance(),...body.filter(node=>!t.isContinueStatement(node)).map(node=>t.cloneNode(node,true)));}
  statements.push(advance()); // The final unmatched switch read also increments.
  if(statements.length>10_000)return null;
  return t.blockStatement(statements);
}

// Follow only deterministic state transitions. Dynamic state assignments,
// cyclic graphs, fallthrough and switch-wide lexical scopes stay intact.
function stateDispatcher(p,globalWrites){
  const loop=p.node;
  if(p.parentPath.isLabeledStatement()||t.isForStatement(loop)&&(loop.init||loop.update))return null;
  const body=t.isBlockStatement(loop.body)&&loop.body.body.length===1?loop.body.body[0]:loop.body;
  if(!t.isSwitchStatement(body)||!t.isIdentifier(body.discriminant))return null;
  const binding=p.scope.getBinding(body.discriminant.name);
  if(!unconditionalDeclaration(binding)||!initializedFor(binding,p)||globalWrites&&binding.scope.path.isProgram())return null;
  const initial=literal(binding.path.node.init),test=loop.test;
  if(!['number','string'].includes(typeof initial))return null;
  let terminal=UNKNOWN;
  if(test&&!t.isBooleanLiteral(test,{value:true})){
    if(!t.isBinaryExpression(test,{operator:'!=='})||!t.isIdentifier(test.left,{name:binding.identifier.name}))return null;
    terminal=literal(test.right);if(!['number','string'].includes(typeof terminal))return null;
  }
  const cases=new Map(),writes=new Set();
  for(const entry of body.cases){
    const value=literal(entry.test),statements=entry.consequent,last=statements.at(-1);
    if(!['number','string'].includes(typeof value)||cases.has(typeof value+':'+value)||!last)return null;
    const exits=t.isReturnStatement(last)||t.isThrowStatement(last);
    if(!exits&&!(t.isBreakStatement(last)||t.isContinueStatement(last))||last.label)return null;
    let transition,next;
    if(!exits){
      transition=statements.at(-2)?.expression;
      if(!t.isAssignmentExpression(transition,{operator:'='})||!t.isIdentifier(transition.left,{name:binding.identifier.name}))return null;
      next=literal(transition.right);if(!['number','string'].includes(typeof next))return null;
      writes.add(transition);
    }
    let unsafe=false;
    for(const statement of statements)t.traverseFast(statement,node=>{
      if(t.isVariableDeclaration(node)&&node.kind!=='var'||t.isClassDeclaration(node)||t.isFunctionDeclaration(node)
        ||(t.isBreakStatement(node)||t.isContinueStatement(node))&&node!==last)unsafe=true;
    });
    if(unsafe)return null;
    cases.set(typeof value+':'+value,{statements,exits,next});
  }
  if(binding.constantViolations.some(write=>!writes.has(write.node)))return null;
  const collected=hoists(body);if(collected.unsupported)return null;
  const output=declarations(collected.names),seen=new Set();let state=initial,complete=false;
  for(let step=0;step<1000;step++){
    if(terminal!==UNKNOWN&&state===terminal){complete=true;break;}
    const id=typeof state+':'+state,entry=cases.get(id);
    if(seen.has(id)||!entry)return null;seen.add(id);
    output.push(...entry.statements.filter(node=>!t.isBreakStatement(node)&&!t.isContinueStatement(node)).map(node=>t.cloneNode(node,true)));
    if(entry.exits){complete=true;break;}state=entry.next;
    if(output.length>10_000)return null;
  }
  return complete?t.blockStatement(output):null;
}

export function advanced(ast,{passes=6}={}) {
  const stats={literalCalls:0,helperCalls:0,expressionFolds:0,constantReads:0,proxyReads:0,proxyCalls:0,deadBranches:0,dispatchers:0,stateDispatchers:0,constantSwitches:0,deadLoops:0,singleIterationLoops:0,passes:0,skipped:null};
  const {directEval,intrinsicsChanged,globalWrites}=staticSafety(ast);
  if(directEval){stats.skipped='Direct eval prevents reliable data-flow transforms.';return stats;}
  for(let round=0;round<passes;round++){
    traverse(ast,{Program(p){p.scope.crawl();p.stop();}});
    const before=JSON.stringify(stats), tables=new Map(), helpers=new WeakMap(),unsafe=dynamicBindings(ast);
    traverse(ast,{WithStatement(p){p.skip();},Scopable(p){for(const binding of Object.values(p.scope.bindings))if(binding.scope===p.scope&&!tables.has(binding)&&!unsafe.has(binding)){
        if(globalWrites&&binding.scope.path.isProgram())continue;
        const entries=proxyTable(binding);if(entries)tables.set(binding,entries);}},
      ReferencedIdentifier(p){const binding=p.scope.getBinding(p.node.name);
        if(!binding?.constant||unsafe.has(binding)||globalWrites&&binding.scope.path.isProgram()||!unconditionalDeclaration(binding)||binding.path.node.end==null||p.node.start==null
          ||binding.path.node.end>=p.node.start||binding.path.getFunctionParent()!==p.getFunctionParent())return;
        const value=literal(binding.path.node.init,binding.scope);if(value===UNKNOWN||!replaceable(value))return;
        // Function names and public keys are never touched; this edits reads.
        if(p.parentPath.isExportSpecifier())return;
        p.replaceWith(t.valueToNode(value));stats.constantReads++;
      },
      MemberExpression:{exit(p){const n=p.node;if(!t.isIdentifier(n.object)||n.optional||isWrite(p))return;
        const entries=tables.get(p.scope.getBinding(n.object.name)), field=n.computed?t.isStringLiteral(n.property)||t.isNumericLiteral(n.property)?String(n.property.value):null:key(n.property);
        const entry=entries?.get(field);if(!entry||!Object.hasOwn(entry,'value'))return;
        const parent=p.parentPath;if(parent.isCallExpression()&&parent.node.callee===n||parent.isNewExpression()||parent.isTaggedTemplateExpression())return;
        const binding=p.scope.getBinding(n.object.name);if(!initializedFor(binding,p))return;
        p.replaceWith(t.valueToNode(entry.value));stats.proxyReads++;
      }},
      CallExpression:{exit(p){const n=p.node;
        if(!intrinsicsChanged && t.isIdentifier(n.callee)){
          let binding=p.scope.getBinding(n.callee.name);const aliases=new Set();
          while(binding?.constant&&binding.path.isVariableDeclarator()&&t.isIdentifier(binding.path.node.init)
            &&initializedFor(binding,p)&&!(globalWrites&&binding.scope.path.isProgram())&&!aliases.has(binding)){
            aliases.add(binding);binding=binding.path.scope.getBinding(binding.path.node.init.name);
          }
          const container=binding?.path.parentPath;
          const available=binding?.path.isFunctionDeclaration()
            ? container.isProgram()||container.isBlockStatement()&&container.parentPath.isFunction()&&container.key==='body'
            : initializedFor(binding,p);
          if(binding && available && !unsafe.has(binding) && !(globalWrites&&binding.scope.path.isProgram())){
            if(!helpers.has(binding))helpers.set(binding,primitiveHelper(binding,{cache:helpers}));
            const helper=helpers.get(binding),args=n.arguments.map(arg=>literal(arg,p.scope));
            if(helper && helper.requirements.every(required=>!unsafe.has(required)&&(required.path.isFunctionDeclaration()||initializedFor(required,p))
              && !(globalWrites&&required.scope.path.isProgram())) && args.every(value=>value!==UNKNOWN&&boundedValue(value))){
              const value=interpretHelper(helper,args);
              if(value!==UNKNOWN_HELPER && boundedValue(value)){
                p.replaceWith(valueNode(value));stats.helperCalls++;return;
              }
            }
          }
        }
        if(t.isMemberExpression(n.callee)&&t.isIdentifier(n.callee.object)&&!n.callee.optional){
          const binding=p.scope.getBinding(n.callee.object.name),entries=tables.get(binding);
          const field=n.callee.computed?t.isStringLiteral(n.callee.property)?n.callee.property.value:null:key(n.callee.property);
          const entry=entries?.get(field);
          if(entry?.fn && initializedFor(binding,p)){
            const expression=inlineWrapper(entry.fn,n.arguments);if(expression){p.replaceWith(expression);stats.proxyCalls++;return;}
          }
        }
        const value=staticCall(p,intrinsicsChanged);
        if(value!==UNKNOWN&&boundedValue(value)){p.replaceWith(valueNode(value));stats.literalCalls++;}
      }},
      'BinaryExpression|UnaryExpression|LogicalExpression|ConditionalExpression':{exit(p){
        const value=primitiveLiteral(p.node);
        if(value!==UNKNOWN_LITERAL&&replaceable(value)&&bounded(value)){
          const replacement=t.valueToNode(value);if(!t.isNodesEquivalent(p.node,replacement)){p.replaceWith(replacement);stats.expressionFolds++;}
        }
      }},
      IfStatement:{exit(p){const value=literal(p.node.test,p.scope);if(value===UNKNOWN||!atom(value))return;
        const discarded=value?p.node.alternate:p.node.consequent,chosen=value?p.node.consequent:p.node.alternate;
        const removed=hoists(discarded);if(removed.unsupported)return;
        // Annex B function declarations in either arm are context-sensitive.
        if(hoists(chosen).unsupported&&!t.isBlockStatement(chosen))return;
        // If statements fill empty completions with undefined. A bare block
        // would inherit the preceding expression's value through a break.
        const list=[t.expressionStatement(t.unaryExpression('void',t.numericLiteral(0))),...declarations(removed.names),...(chosen?[t.cloneNode(chosen,true)]:[])];
        p.replaceWith(t.blockStatement(list));stats.deadBranches++;
      }},
      SwitchStatement:{exit(p){const replacement=constantSwitch(p);if(replacement){p.replaceWith(replacement);stats.constantSwitches++;}}},
      'WhileStatement|ForStatement|DoWhileStatement':{exit(p){
        const loop=constantLoop(p);if(loop){const once=p.isDoWhileStatement();p.replaceWith(loop);stats[once?'singleIterationLoops':'deadLoops']++;return;}
        if(p.isDoWhileStatement())return;
        const replacement=dispatcher(p,globalWrites);if(replacement){p.replaceWith(replacement);stats.dispatchers++;return;}
        const state=stateDispatcher(p,globalWrites);if(state){p.replaceWith(state);stats.stateDispatchers++;}
      }}
    });
    stats.passes++;
    const after={...stats,passes:stats.passes-1};if(JSON.stringify(after)===before)break;
  }
  return stats;
}

export function diagnostics(ast) {
  const result={switches:0,asyncStateMachines:0,possibleDispatchers:0,dynamicCodeSites:0,debuggerStatements:0};
  traverse(ast,{SwitchStatement(p){result.switches++;const d=p.node.discriminant;
    if(t.isAssignmentExpression(d)&&t.isMemberExpression(d.left)&&t.isMemberExpression(d.right)
      &&key(d.left.property)==='prev'&&key(d.right.property)==='next'
      &&t.isIdentifier(d.left.object)&&t.isIdentifier(d.right.object,{name:d.left.object.name}))result.asyncStateMachines++;
    else if(t.isMemberExpression(d)&&t.isUpdateExpression(d.property))result.possibleDispatchers++;
  },CallExpression(p){if(t.isIdentifier(p.node.callee)&&['eval','Function'].includes(p.node.callee.name))result.dynamicCodeSites++;},
  NewExpression(p){if(t.isIdentifier(p.node.callee,{name:'Function'}))result.dynamicCodeSites++;},DebuggerStatement(){result.debuggerStatements++;}});
  return result;
}
