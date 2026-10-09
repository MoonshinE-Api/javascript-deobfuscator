import * as t from '@babel/types';
import {primitiveLiteral, UNKNOWN_LITERAL} from './clean-junk.js';
import {nativeFunctions,nativeMethodNames,staticMethodNames,nativeCall,nativeStatic,nativeMethod,
  UNKNOWN_NATIVE,boundedValue,primitiveValue} from './native-values.js';

const UNKNOWN = Symbol('unsupported helper');
const RETURN = Symbol('return'), BREAK = Symbol('break'), CONTINUE = Symbol('continue');
const MAX_LENGTH = 100_000, MAX_STEPS = 1_000_000;
const primitive = value => value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
const functions = nativeFunctions;
const field = node => node.computed ? t.isStringLiteral(node.property) ? node.property.value : null : node.property.name;

export function capturedValue(binding) {
  if(!binding?.constant||!binding.path.isVariableDeclarator())return UNKNOWN;
  const init=binding.path.node.init,value=primitiveLiteral(init);
  if(value!==UNKNOWN_LITERAL)return value;
  if(!t.isArrayExpression(init)||init.elements.length>10_000)return UNKNOWN;
  const values=init.elements.map(item=>primitiveLiteral(item));
  if(values.some(item=>item===UNKNOWN_LITERAL)||values.reduce((n,item)=>n+String(item).length,0)>MAX_LENGTH)return UNKNOWN;
  for(const ref of binding.referencePaths){
    const member=ref.parentPath,parent=member.parentPath;
    if(!member.isMemberExpression()||member.node.object!==ref.node||member.node.optional)return UNKNOWN;
    // Table values can be read, never assigned, passed as a table, invoked,
    // deleted, or used as destructuring/loop targets.
    if(parent.isCallExpression()&&parent.node.callee===member.node||parent.isNewExpression()||parent.isTaggedTemplateExpression())return UNKNOWN;
    for(let current=member;current.parentPath;current=current.parentPath){const owner=current.parentPath;
      if(owner.isAssignmentExpression()){if(owner.node.left===current.node)return UNKNOWN;break;}
      if(owner.isUpdateExpression()||owner.isUnaryExpression({operator:'delete'}))return UNKNOWN;
      if(owner.isForInStatement()||owner.isForOfStatement()){if(owner.node.left===current.node)return UNKNOWN;break;}
      if(!(owner.isObjectProperty()||owner.isObjectPattern()||owner.isArrayPattern()||owner.isRestElement()||owner.isAssignmentPattern()))break;
    }
  }
  return values;
}

// Recognize a closed helper over primitive parameters and its own locals.
// The input is interpreted as AST data; it is never called, eval'd, or compiled.
export function primitiveHelper(binding,{cache=new WeakMap(),active=new Set(),depth=0}={}) {
  if(!binding||active.has(binding)||depth>16)return null;
  if(cache.has(binding))return cache.get(binding);
  active=new Set([...active,binding]);cache.set(binding,null);
  if (!binding?.constant) return null;
  const fnPath = binding.path.isVariableDeclarator() ? binding.path.get('init') : binding.path;
  if (!fnPath.isFunction() || fnPath.node.async || fnPath.node.generator) return null;
  const fn = fnPath.node;
  if (fn.params.length > 16 || !fn.params.every(param => t.isIdentifier(param))) return null;
  const names = new Set(fn.params.map(param => param.name)), declarations = new Map(), captures = new Map(),dependencies=new Map(),requirements=[];
  if (names.size !== fn.params.length) return null;
  let valid = true, count = 0;
  fnPath.traverse({
    enter(p) {
      if (++count > 2000) { valid = false; p.stop(); }
      if (p.isFunction()) { valid = false; p.skip(); }
    },
    VariableDeclaration(p) {
      for (const item of p.node.declarations) {
        if (!t.isIdentifier(item.id)) { valid = false; continue; }
        if(names.has(item.id.name)){
          if(p.node.kind!=='var'||declarations.has(item.id.name)&&declarations.get(item.id.name)!=='var')valid=false;
          continue;
        }
        names.add(item.id.name); declarations.set(item.id.name, p.node.kind);
      }
    }
  });
  if (!valid) return null;
  fnPath.traverse({ReferencedIdentifier(p) {
    const name = p.node.name, target = p.scope.getBinding(name);
    if (names.has(name) && target && (target.scope === fnPath.scope || target.path.findParent(owner => owner === fnPath))) return;
    const value=capturedValue(target);
    if(value!==UNKNOWN){captures.set(name,{binding:target,value});return;}
    const parent = p.parentPath;
    if(target&&parent.isCallExpression()&&parent.node.callee===p.node){
      let candidate=target;const aliases=new Set();
      while(candidate?.constant&&candidate.path.isVariableDeclarator()&&t.isIdentifier(candidate.path.node.init)&&!aliases.has(candidate)){
        aliases.add(candidate);requirements.push(candidate);candidate=candidate.path.scope.getBinding(candidate.path.node.init.name);
      }
      const container=candidate?.path.parentPath;
      const unconditional=candidate?.path.isFunctionDeclaration()
        ?container.isProgram()||container.isBlockStatement()&&container.parentPath.isFunction()&&container.key==='body'
        :candidate?.path.isVariableDeclarator();
      const helper=unconditional?primitiveHelper(candidate,{cache,active,depth:depth+1}):null;
      if(helper){dependencies.set(name,helper);requirements.push(...helper.requirements,candidate);return;}
    }
    if (Object.hasOwn(functions, name) && !target && parent.isCallExpression() && parent.node.callee === p.node) return;
    if (Object.hasOwn(staticMethodNames,name) && !target && parent.isMemberExpression() && parent.node.object === p.node
      && staticMethodNames[name].has(field(parent.node)) && parent.parentPath.isCallExpression()
      && parent.parentPath.node.callee === parent.node) return;
    valid = false;
  }});
  const expr = n => {
    if (!n) return false;
    if (t.isStringLiteral(n) || t.isNumericLiteral(n) || t.isBooleanLiteral(n) || t.isNullLiteral(n)) return true;
    if (t.isIdentifier(n)) return names.has(n.name)||captures.has(n.name);
    if(t.isArrayExpression(n))return n.elements.length<=10_000&&n.elements.every(item=>item&&expr(item)&&!t.isSpreadElement(item));
    if(t.isTemplateLiteral(n))return n.expressions.every(expr);
    if (t.isUnaryExpression(n)) return ['!', '+', '-', '~', 'typeof', 'void'].includes(n.operator) && expr(n.argument);
    if (t.isBinaryExpression(n)) return ['+', '-', '*', '/', '%', '**', '|', '&', '^', '<<', '>>', '>>>', '==', '!=', '===', '!==', '<', '<=', '>', '>='].includes(n.operator) && expr(n.left) && expr(n.right);
    if (t.isLogicalExpression(n)) return expr(n.left) && expr(n.right);
    if (t.isConditionalExpression(n)) return expr(n.test) && expr(n.consequent) && expr(n.alternate);
    if (t.isSequenceExpression(n)) return n.expressions.every(expr);
    if (t.isAssignmentExpression(n)) return (t.isIdentifier(n.left) && names.has(n.left.name)
      && declarations.get(n.left.name) !== 'const'||t.isMemberExpression(n.left)&&n.left.computed&&expr(n.left.object)&&expr(n.left.property))
      && ['=', '+=', '-=', '^=', '|=', '&=', '*=', '/=', '%=','<<=','>>=','>>>='].includes(n.operator) && expr(n.right);
    if (t.isUpdateExpression(n)) return t.isIdentifier(n.argument) && names.has(n.argument.name) && declarations.get(n.argument.name) !== 'const';
    if (t.isMemberExpression(n)) return !n.optional && expr(n.object) && (n.computed ? expr(n.property) : n.property.name === 'length');
    if (t.isCallExpression(n) && !n.optional && n.arguments.length <= 16 && n.arguments.every(expr)) {
      if (t.isIdentifier(n.callee)) return dependencies.has(n.callee.name)||Object.hasOwn(functions, n.callee.name) && !fnPath.scope.getBinding(n.callee.name);
      if (t.isMemberExpression(n.callee) && !n.callee.optional) {
        if (t.isIdentifier(n.callee.object)&&staticMethodNames[n.callee.object.name]?.has(field(n.callee)))return !fnPath.scope.getBinding(n.callee.object.name);
        return nativeMethodNames.has(field(n.callee)) && expr(n.callee.object);
      }
    }
    return false;
  };
  const statement = n => {
    if (t.isBlockStatement(n)) return n.body.every(statement);
    if (t.isReturnStatement(n)) return !n.argument || expr(n.argument);
    if (t.isVariableDeclaration(n)) return n.declarations.every(item => !item.init || expr(item.init));
    if (t.isExpressionStatement(n)) return expr(n.expression);
    if (t.isIfStatement(n)) return expr(n.test) && statement(n.consequent) && (!n.alternate || statement(n.alternate));
    if (t.isForStatement(n)) return (!n.init || (t.isVariableDeclaration(n.init) ? statement(n.init) : expr(n.init)))
      && (!n.test || expr(n.test)) && (!n.update || expr(n.update)) && statement(n.body);
    if (t.isWhileStatement(n)) return expr(n.test) && statement(n.body);
    if(t.isDoWhileStatement(n))return expr(n.test)&&statement(n.body);
    if(t.isForOfStatement(n))return !n.await&&t.isVariableDeclaration(n.left)&&n.left.declarations.length===1&&!n.left.declarations[0].init&&expr(n.right)&&statement(n.body);
    if(t.isSwitchStatement(n))return expr(n.discriminant)&&n.cases.every(entry=>(!entry.test||expr(entry.test))&&entry.consequent.every(statement));
    return t.isEmptyStatement(n) || (t.isBreakStatement(n) || t.isContinueStatement(n)) && !n.label;
  };
  if (!valid || !(t.isBlockStatement(fn.body) ? statement(fn.body) : expr(fn.body))) return null;
  requirements.push(...[...captures.values()].map(capture=>capture.binding));
  const result={fn,declarations,captures,dependencies,requirements:[...new Set(requirements)]};cache.set(binding,result);return result;
}

export function interpretHelper(helper, args,{budget={steps:0}}={}) {
  if (args.length > 16 || !args.every(boundedValue)) return UNKNOWN;
  const owned=new WeakSet(),TDZ=Symbol('uninitialized local');
  const tick = () => { if (++budget.steps > MAX_STEPS) throw UNKNOWN; };
  const bounded = value => {if(!boundedValue(value))throw UNKNOWN;return value;};
  const localArray=value=>{owned.add(value);return bounded(value);};
  const locals = new Map(helper.fn.params.map((param, index) => [param.name, Array.isArray(args[index])?localArray(args[index].slice()):bounded(args[index])]));
  for(const [name,capture] of helper.captures)locals.set(name,capture.value);
  for (const [name, kind] of helper.declarations) if (kind === 'var') locals.set(name, undefined);
  const read = name => { if (!locals.has(name)||locals.get(name)===TDZ) throw UNKNOWN; return locals.get(name); };
  const binary = (op, a, b) => {
    if(!primitive(a)||!primitive(b))throw UNKNOWN;
    switch (op) {
      case '+': return bounded(a + b); case '-': return a - b; case '*': return a * b; case '/': return a / b;
      case '%': return a % b; case '**': return a ** b; case '^': return a ^ b; case '|': return a | b; case '&': return a & b;
      case '<<': return a << b; case '>>': return a >> b; case '>>>': return a >>> b;
      case '==': return a == b; case '!=': return a != b; case '===': return a === b; case '!==': return a !== b;
      case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
      default: throw UNKNOWN;
    }
  };
  const evaluate = n => {
    tick();
    if (t.isLiteral(n)) return t.isNullLiteral(n) ? null : bounded(n.value);
    if (t.isIdentifier(n)) return read(n.name);
    if(t.isArrayExpression(n))return localArray(n.elements.map(evaluate));
    if(t.isTemplateLiteral(n)){let value=n.quasis[0].value.cooked;for(let i=0;i<n.expressions.length;i++){const part=evaluate(n.expressions[i]);if(!primitive(part))throw UNKNOWN;value=bounded(value+String(part)+n.quasis[i+1].value.cooked);}return value;}
    if (t.isBinaryExpression(n)) return bounded(binary(n.operator, evaluate(n.left), evaluate(n.right)));
    if (t.isUnaryExpression(n)) {
      const a = evaluate(n.argument);
      if(!primitive(a))throw UNKNOWN;
      switch (n.operator) {case '!': return !a; case '+': return +a; case '-': return -a; case '~': return ~a; case 'typeof': return typeof a; case 'void': return undefined;}
    }
    if (t.isLogicalExpression(n)) {const a = evaluate(n.left); return n.operator === '&&' ? a && evaluate(n.right) : n.operator === '||' ? a || evaluate(n.right) : a ?? evaluate(n.right);}
    if (t.isConditionalExpression(n)) return evaluate(evaluate(n.test) ? n.consequent : n.alternate);
    if (t.isSequenceExpression(n)) {let value; for (const item of n.expressions) value = evaluate(item); return value;}
    if (t.isAssignmentExpression(n)) {
      let receiver,key;
      if(t.isMemberExpression(n.left)){
        receiver=evaluate(n.left.object);key=evaluate(n.left.property);
        if(!Array.isArray(receiver)||!owned.has(receiver)||!Number.isInteger(+key)||+key<0||+key>=10_000||String(+key)!==String(key))throw UNKNOWN;
      }else read(n.left.name);
      const old = n.operator === '=' ? undefined : receiver?receiver[key]:read(n.left.name), value = evaluate(n.right);
      const assigned = n.operator === '=' ? value : binary(n.operator.slice(0, -1), old, value);
      if(receiver){if(!primitive(assigned))throw UNKNOWN;receiver[key]=assigned;bounded(receiver);}
      else locals.set(n.left.name, bounded(assigned));return assigned;
    }
    if (t.isUpdateExpression(n)) {
      const old = +read(n.argument.name), value = n.operator === '++' ? old + 1 : old - 1;
      locals.set(n.argument.name, value); return n.prefix ? value : old;
    }
    if (t.isMemberExpression(n)) {
      const receiver = evaluate(n.object), key = n.computed ? evaluate(n.property) : n.property.name;
      if (typeof receiver !== 'string'&&!Array.isArray(receiver)) throw UNKNOWN;
      if (key === 'length') return receiver.length;
      if (/^(0|[1-9]\d*)$/.test(String(key))) return receiver[Number(key)];
      throw UNKNOWN;
    }
    if (t.isCallExpression(n)) {
      // JS evaluates the receiver before arguments.
      const owner=t.isMemberExpression(n.callee)&&t.isIdentifier(n.callee.object)&&staticMethodNames[n.callee.object.name]?.has(field(n.callee))?n.callee.object.name:null;
      const receiver = t.isMemberExpression(n.callee) && !owner ? evaluate(n.callee.object) : null;
      const values = n.arguments.map(evaluate);
      if(t.isIdentifier(n.callee)&&helper.dependencies.has(n.callee.name)){
        if(!values.every(primitive))throw UNKNOWN;
        const result=interpretHelper(helper.dependencies.get(n.callee.name),values,{budget});
        if(result===UNKNOWN)throw UNKNOWN;return Array.isArray(result)?localArray(result):bounded(result);
      }
      const value=t.isIdentifier(n.callee)?nativeCall(n.callee.name,values):owner?nativeStatic(owner,field(n.callee),values)
        :nativeMethod(receiver,field(n.callee),values,{mutable:Array.isArray(receiver)&&owned.has(receiver)});
      if(value===UNKNOWN_NATIVE)throw UNKNOWN;
      if(Array.isArray(value)&&value!==receiver)return localArray(value);
      return bounded(value);
    }
    throw UNKNOWN;
  };
  const execute = n => {
    tick();
    if (t.isBlockStatement(n)) {
      const lexical=n.body.filter(item=>t.isVariableDeclaration(item)&&item.kind!=='var').flatMap(item=>item.declarations.map(d=>d.id.name));
      const prior=new Map(lexical.map(name=>[name,locals.has(name)?locals.get(name):TDZ]));for(const name of lexical)locals.set(name,TDZ);
      try{for (const item of n.body) {const completion = execute(item); if (completion) return completion;}}
      finally{for(const name of lexical){if(prior.get(name)===TDZ)locals.delete(name);else locals.set(name,prior.get(name));}}return;
    }
    if (t.isReturnStatement(n)) return {kind: RETURN, value: n.argument ? evaluate(n.argument) : undefined};
    if (t.isVariableDeclaration(n)) {for (const item of n.declarations) if (item.init || n.kind !== 'var') locals.set(item.id.name, item.init ? evaluate(item.init) : undefined); return;}
    if (t.isExpressionStatement(n)) {evaluate(n.expression); return;}
    if (t.isIfStatement(n)) {const branch = evaluate(n.test) ? n.consequent : n.alternate; return branch ? execute(branch) : undefined;}
    if (t.isForStatement(n) || t.isWhileStatement(n)||t.isDoWhileStatement(n)) {
      const lexical=t.isVariableDeclaration(n.init)&&n.init.kind!=='var'?n.init.declarations.map(d=>d.id.name):[];
      for(const name of lexical)locals.set(name,TDZ);
      try{if (n.init) t.isVariableDeclaration(n.init) ? execute(n.init) : evaluate(n.init);
      let first=t.isDoWhileStatement(n);
      while (first||!n.test || evaluate(n.test)) {
        first=false;
        tick(); const completion = execute(n.body);
        if (completion?.kind === RETURN) return completion;
        if (completion?.kind === BREAK) break;
        if (n.update) evaluate(n.update);
      }
      }finally{for(const name of lexical)locals.delete(name);}return;
    }
    if(t.isForOfStatement(n)){
      const values=evaluate(n.right);if(!Array.isArray(values)&&typeof values!=='string')throw UNKNOWN;
      const name=n.left.declarations[0].id.name,lexical=n.left.kind!=='var';
      try{for(const value of values){tick();locals.set(name,value);const completion=execute(n.body);if(completion?.kind===RETURN)return completion;if(completion?.kind===BREAK)break;}}
      finally{if(lexical)locals.delete(name);}return;
    }
    if(t.isSwitchStatement(n)){
      if(n.cases.some(entry=>entry.consequent.some(item=>t.isVariableDeclaration(item)&&item.kind!=='var')))throw UNKNOWN;
      const value=evaluate(n.discriminant);let start=-1,fallback=-1;
      for(let i=0;i<n.cases.length;i++){if(!n.cases[i].test)fallback=i;else if(evaluate(n.cases[i].test)===value){start=i;break;}}
      if(start<0)start=fallback;if(start<0)return;
      for(let i=start;i<n.cases.length;i++)for(const item of n.cases[i].consequent){const completion=execute(item);if(completion?.kind===BREAK)return;if(completion)return completion;}return;
    }
    if (t.isBreakStatement(n)) return {kind: BREAK};
    if (t.isContinueStatement(n)) return {kind: CONTINUE};
  };
  try {
    const result=value=>Array.isArray(value)&&!owned.has(value)?UNKNOWN:bounded(value);
    if (!t.isBlockStatement(helper.fn.body)) return result(evaluate(helper.fn.body));
    const completion = execute(helper.fn.body);
    return completion?.kind === RETURN ? result(completion.value) : completion ? UNKNOWN : undefined;
  } catch { return UNKNOWN; }
}

export {UNKNOWN as UNKNOWN_HELPER};
