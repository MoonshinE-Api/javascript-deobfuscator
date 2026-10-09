import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import {parse} from '@babel/parser';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule;
const unknown=Symbol('unknown'),print=n=>generate(n,{comments:false}).code;
function clone(x,seen=new Map()){
  if(!x||typeof x!=='object')return x;if(seen.has(x))return seen.get(x);
  const out=Array.isArray(x)?[]:Object.create(null);seen.set(x,out);for(const [k,v] of Object.entries(x))out[k]=clone(v,seen);return out;
}
const copy=env=>{const seen=new Map();return new Map([...env].map(([k,v])=>[k,clone(v,seen)]));};
const key=(node,env)=>!node.computed&&t.isIdentifier(node.property)?node.property.name:read(node.property,env);
const value=(node,env)=>{
  if(t.isIdentifier(node))return env.get(node.name)??unknown;
  if(t.isMemberExpression(node)){const o=read(node.object,env),k=key(node,env);if(o!==unknown&&o!==null&&typeof o==='object'&&typeof k!=='symbol')return Object.hasOwn(o,k)?o[k]:undefined;}
  return unknown;
};
function write(node,env,v){
  if(t.isIdentifier(node)){env.set(node.name,v);return true;}
  if(t.isMemberExpression(node)){const o=read(node.object,env),k=key(node,env);if(o!==unknown&&o!==null&&typeof o==='object'&&typeof k!=='symbol'&&!['__proto__','constructor','prototype'].includes(k)){o[k]=v;return true;}}
  return false;
}
function binary(op,a,b){
  if(a===unknown||b===unknown)return unknown;
  // Never invoke object conversion or input-provided methods.
  if(a!==null&&typeof a==='object'||b!==null&&typeof b==='object')return unknown;
  switch(op){case '+':return a+b;case '-':return a-b;case '*':return a*b;case '/':return a/b;case '%':return a%b;
    case '===':return a===b;case '!==':return a!==b;case '==':return a==b;case '!=':return a!=b;
    case '<':return a<b;case '<=':return a<=b;case '>':return a>b;case '>=':return a>=b;
    case '|':return a|b;case '&':return a&b;case '^':return a^b;case '<<':return a<<b;case '>>':return a>>b;case '>>>':return a>>>b;default:return unknown;}
}
function read(n,env){
  if(!n)return undefined;
  if(t.isNumericLiteral(n)||t.isStringLiteral(n)||t.isBooleanLiteral(n))return n.value;
  if(t.isNullLiteral(n))return null;
  if(t.isIdentifier(n)){if(env.has(n.name))return env.get(n.name);if(n.name==='undefined')return undefined;return unknown;}
  if(t.isMemberExpression(n))return value(n,env);
  if(t.isArrayExpression(n))return n.elements.map(e=>read(e,env));
  if(t.isObjectExpression(n)){
    const out=Object.create(null);for(const p of n.properties){if(!t.isObjectProperty(p)||p.computed||!t.isIdentifier(p.key)&&!t.isStringLiteral(p.key))return unknown;out[p.key.name??p.key.value]=read(p.value,env);}return out;
  }
  if(t.isSequenceExpression(n)){let result;for(const e of n.expressions)result=read(e,env);return result;}
  if(t.isUnaryExpression(n)){
    const v=read(n.argument,env);if(v===unknown||v!==null&&typeof v==='object')return unknown;
    switch(n.operator){case 'void':return undefined;case '!':return !v;case '-':return -v;case '+':return +v;case '~':return ~v;case 'typeof':return typeof v;default:return unknown;}
  }
  if(t.isBinaryExpression(n))return binary(n.operator,read(n.left,env),read(n.right,env));
  if(t.isLogicalExpression(n)){const a=read(n.left,env);if(a===unknown)return unknown;return n.operator==='&&'?a&&read(n.right,env):n.operator==='||'?a||read(n.right,env):a??read(n.right,env);}
  if(t.isConditionalExpression(n)){const c=read(n.test,env);return c===unknown?unknown:read(c?n.consequent:n.alternate,env);}
  if(t.isAssignmentExpression(n)){const b=read(n.right,env),v=n.operator==='='?b:binary(n.operator.slice(0,-1),read(n.left,env),b);write(n.left,env,v);return v;}
  if(t.isUpdateExpression(n)){const a=read(n.argument,env),v=binary(n.operator==='++'?'+':'-',a,1);write(n.argument,env,v);return n.prefix?v:a;}
  if(t.isCallExpression(n)&&print(n.callee)==='Array.prototype.slice.call'&&n.arguments.length===1&&t.isIdentifier(n.arguments[0],{name:'arguments'}))return clone(env.get('arguments'));
  return unknown;
}
function projected(n,env,decode){
  const node=t.cloneNode(n,true),wrapped=t.isStatement(node)?node:t.expressionStatement(node),ast=t.file(t.program([wrapped]));
  const isWrite=p=>p.parentPath.isAssignmentExpression()&&p.key==='left'||p.parentPath.isUpdateExpression()||p.parentPath.isUnaryExpression({operator:'delete'});
  traverse(ast,{noScope:true,Function(p){p.skip();},Identifier(p){if(!p.isReferencedIdentifier()||isWrite(p))return;const v=env.get(p.node.name);if(typeof v==='number'&&Number.isFinite(v))p.replaceWith(t.valueToNode(v));},
    CallExpression:{exit(p){if(!decode||!t.isIdentifier(p.node.callee)||p.node.arguments.length!==1||!t.isNumericLiteral(p.node.arguments[0]))return;const candidate=decode(p.node.callee.name,p.node.arguments[0].value);if(typeof candidate==='string')p.replaceWith(t.stringLiteral(candidate));}},
    'BinaryExpression|UnaryExpression':{exit(p){if(t.isUnaryExpression(p.node)&&!['-','+','!','~','void'].includes(p.node.operator))return;const v=read(p.node,copy(env));if(typeof v==='number'&&Number.isFinite(v)||typeof v==='boolean'){const next=t.valueToNode(v);if(!t.isNodesEquivalent(next,p.node))p.replaceWith(next);}}},
    MemberExpression:{exit(p){if(p.node.computed&&t.isStringLiteral(p.node.property)&&t.isValidIdentifier(p.node.property.value)){p.node.computed=false;p.node.property=t.identifier(p.node.property.value);}if(isWrite(p))return;const v=read(p.node,copy(env));if(typeof v==='number'&&Number.isFinite(v))p.replaceWith(t.valueToNode(v));}}
  });return print(t.isStatement(n)?ast.program.body[0]:ast.program.body[0].expression);
}
function execute(statements,env,{conditions=[],code=[],depth=0,decode}={}){
  if(depth>40)return [{env,conditions,code,status:'unresolved: branching depth'}];
  for(let i=0;i<statements.length;i++){
    const n=statements[i];
    if(t.isBlockStatement(n))return execute([...n.body,...statements.slice(i+1)],env,{conditions,code,depth:depth+1,decode});
    if(t.isIfStatement(n)){
      const condition=projected(n.test,env,decode),test=read(n.test,env),paths=test===unknown?[true,false]:[!!test],out=[];
      for(const yes of paths){const branch=yes?n.consequent:n.alternate,body=branch?(t.isBlockStatement(branch)?branch.body:[branch]):[];
        out.push(...execute([...body,...statements.slice(i+1)],copy(env),{conditions:test===unknown?[...conditions,(yes?'':'!(')+condition+(yes?'':')')]:conditions,code:[...code],depth:depth+1,decode}));}
      return out.slice(0,32);
    }
    if(t.isBreakStatement(n))return [{env,conditions,code,status:n.label?'unresolved: labeled break':'next'}];
    if(t.isReturnStatement(n)||t.isThrowStatement(n))return [{env,conditions,code:[...code,projected(n,env,decode)],status:t.isReturnStatement(n)?'return':'throw'}];
    if(t.isExpressionStatement(n)){const text=projected(n,env,decode);read(n.expression,env);code.push(text);continue;}
    if(t.isVariableDeclaration(n)){for(const d of n.declarations)if(t.isIdentifier(d.id)&&d.init)env.set(d.id.name,read(d.init,env));code.push(print(n));continue;}
    if(t.isEmptyStatement(n))continue;
    return [{env,conditions,code:[...code,print(n)],status:'unresolved: '+n.type}];
  }
  return [{env,conditions,code,status:'next'}];
}

export function dispatcherReading(ast,{maxStates=80,maxMachines=64,resolveCandidate}={}){
  const machines=[];
  traverse(ast,{Function(p){
    if(machines.length>=maxMachines||!p.isFunctionDeclaration()||!p.node.id||!t.isBlockStatement(p.node.body))return;
    const loops=[];let evalFound=false;
    p.traverse({Function(q){q.skip();},CallExpression(q){if(t.isIdentifier(q.node.callee,{name:'eval'}))evalFound=true;},ForStatement(q){
      let sw=null;q.traverse({Function(r){r.skip();},WithStatement(r){if(t.isSwitchStatement(r.node.body)&&r.findParent(a=>a.isLoop())===q)sw=r.node.body;}});
      if(sw&&!q.node.update)loops.push({loop:q.node,loopPath:q,sw});
    }});
    if(evalFound||loops.length!==1)return;
    const {loop,loopPath,sw}=loops[0],binding=p.parentPath.scope.getBinding(p.node.id.name),starts=[];
    for(const ref of binding?.referencePaths??[]){
      const call=ref.parentPath;if(!call.isCallExpression()||call.node.callee!==ref.node||call.node.arguments.length<1)continue;
      const args=call.node.arguments.map(n=>read(n,new Map()));if(args.every(v=>v!==unknown))starts.push({args,line:call.node.loc?.start.line});
    }
    if(!starts.length)return;
    const decode=resolveCandidate?(name,index)=>resolveCandidate(name,index,p.scope):undefined;
    const controlNames=new Set();for(const n of [sw.discriminant,loop.test,...sw.cases.map(c=>c.test).filter(Boolean)])t.traverseFast(n,r=>{if(t.isIdentifier(r))controlNames.add(r.name);});
    let prefix=[],child=loopPath;
    while(child.parentPath!==p){
      const parent=child.parentPath;if(!parent?.isBlockStatement()||!parent.node.body.includes(child.node))return;
      prefix=[...parent.node.body.slice(0,parent.node.body.indexOf(child.node)),...prefix];child=parent;
    }
    const nodes=[],queue=[],byState=new Map(),unresolved=[];
    function enqueue(env){
      const discriminant=read(sw.discriminant,copy(env));if(typeof discriminant!=='number'||!Number.isFinite(discriminant))return null;
      const state={};for(const name of [...controlNames].sort()){const v=env.get(name);if(typeof v==='number')state[name]=v;else if(v&&typeof v==='object'){const seen=new Set();state[name]=JSON.stringify(v,(_,x)=>{if(x&&typeof x==='object'){if(seen.has(x))return '[shared object]';seen.add(x);}return x===unknown?'?':x;});}}
      const signature=JSON.stringify(state);if(byState.has(signature))return byState.get(signature);
      if(nodes.length>=maxStates)return null;const id=nodes.length+1;byState.set(signature,id);const row={id,state,discriminant,caseLine:null,edges:[]};nodes.push(row);queue.push({row,env});return id;
    }
    for(const start of starts){const env=new Map([['arguments',start.args]]);p.node.params.forEach((param,i)=>{if(t.isIdentifier(param))env.set(param.name,start.args[i]);});
      execute(prefix,env);if(loop.init){if(t.isVariableDeclaration(loop.init)){for(const d of loop.init.declarations)if(t.isIdentifier(d.id))env.set(d.id.name,read(d.init,env));}else read(loop.init,env);}
      start.state=enqueue(env);
    }
    while(queue.length){
      const {row,env}=queue.shift(),test=read(loop.test,copy(env));if(test===false){row.exit=true;continue;}
      const disc=row.discriminant;let matched=-1,fallback=-1;
      for(let i=0;i<sw.cases.length;i++){const c=sw.cases[i];if(!c.test){fallback=i;continue;}const v=read(c.test,copy(env));if(v===unknown){unresolved.push({state:row.id,reason:'Unknown case expression before selected case'});matched=-2;break;}if(v===disc){matched=i;break;}}
      if(matched===-2)continue;if(matched<0)matched=fallback;
      if(matched<0){unresolved.push({state:row.id,reason:'No matching case'});continue;}
      row.caseLine=sw.cases[matched].loc?.start.line;
      const body=sw.cases.slice(matched).flatMap(c=>c.consequent);
      for(const outcome of execute(body,copy(env),{decode})){let target=null;if(outcome.status==='next')target=enqueue(outcome.env);
        const status=outcome.status==='next'&&!target?'unresolved: nonconstant state or state limit':outcome.status;
        row.edges.push({when:outcome.conditions.map(c=>'('+c+')').join(' && ')||'always',conditions:outcome.conditions,status,target,statements:outcome.code,code:outcome.code.join('\n')});
      }
    }
    const machine={name:p.node.id.name,line:p.node.loc.start.line,discriminant:print(sw.discriminant),starts,nodes,unresolved,controlNames:[...controlNames]};
    machine.pathCode=structuredPath(machine);machines.push(machine);
  }});
  return {machines,maxStates,scope:'Candidate numeric paths inferred from literal call arguments. Calls, object-scope lookup and prototype effects are not executed or proven. Unknown paths remain explicit; use the complete function to verify them.'};
}

function structuredPath(machine){
  const starts=[...new Set(machine.starts.map(s=>s.state).filter(Boolean))];if(starts.length!==1||machine.unresolved.length)return null;
  const controls=new Set(machine.controlNames);let size=0;
  const statements=code=>{
    const nodes=parse(code.join('\n'),{allowReturnOutsideFunction:true}).program.body;
    return nodes.filter(n=>{
      if(!t.isExpressionStatement(n)||!t.isAssignmentExpression(n.expression)&&!t.isUpdateExpression(n.expression))return true;
      const lhs=n.expression.left??n.expression.argument;
      // Numeric dispatcher-register writes are shown by graph edges instead.
      return !(t.isIdentifier(lhs)&&controls.has(lhs.name));
    });
  };
  function follow(id,seen=new Set()){
    if(seen.has(id)||size++>160)throw new Error('Cycle or expansion limit');
    const n=machine.nodes[id-1];if(!n||n.edges.some(e=>e.status.startsWith('unresolved:')))throw new Error('Unresolved path');
    if(n.exit)return [];
    const edges=n.edges;if(!edges.length||edges.length>2)throw new Error('Unsupported branching');
    const next=new Set([...seen,id]);
    const edgeBody=(edge,skip=0)=>[...statements(edge.statements.slice(skip)),...(edge.target?follow(edge.target,next):[])];
    if(edges.length===1){if(edges[0].when!=='always')throw new Error('Incomplete conditional');return edgeBody(edges[0]);}
    const [a,b]=edges;if(a.conditions.length!==1||b.conditions.length!==1||b.conditions[0]!=='!('+a.conditions[0]+')')throw new Error('Complex conditional');
    let shared=0;while(a.statements[shared]!==undefined&&a.statements[shared]===b.statements[shared])shared++;
    const test=parse(a.conditions[0],{sourceType:'script'}).program.body[0];if(!t.isExpressionStatement(test))throw new Error('Invalid condition');
    return [...statements(a.statements.slice(0,shared)),t.ifStatement(test.expression,t.blockStatement(edgeBody(a,shared)),t.blockStatement(edgeBody(b,shared)))];
  }
  try{
    const body=follow(starts[0]),fn=t.functionDeclaration(t.identifier(machine.name+'_candidatePath'),[],t.blockStatement(body));
    return '// INFERRED READING PATH — not an executable replacement.\n// Literal-entry numeric register writes are omitted. Dynamic object scopes and called-function effects remain unproven.\n// Original cleaned function at line '+machine.line+'; verify against full-human-readable.js.\n'+print(fn)+'\n';
  }catch{return null;}
}
export function dispatcherMarkdown(reading){
  const lines=['# Numeric dispatcher reading maps','',reading.scope,''];
  for(const m of reading.machines){lines.push('## '+m.name,'',`Cleaned line ${m.line}; dispatcher: \`${m.discriminant}\`. ${m.nodes.length} inferred states.`,
    '',...m.starts.map(s=>`- Entry at cleaned line ${s.line}: ${JSON.stringify(s.args)} → state ${s.state??'unknown'}.`),'');
    if(m.pathFile)lines.push('[Structured candidate path](../'+m.pathFile+')','');
    for(const n of m.nodes){lines.push('### State '+n.id,'',`Value ${n.discriminant}; selected case at cleaned line ${n.caseLine??'unknown'}${n.exit?'; loop exits':''}.`,'');
      for(const e of n.edges){lines.push(`When \`${e.when.replaceAll('`','\\`')}\`: ${e.target?'go to state '+e.target:e.status}.`,'','```javascript',e.code,'```','');}}
    for(const u of m.unresolved)lines.push(`- State ${u.state}: ${u.reason}.`);
  }
  if(!reading.machines.length)lines.push('No supported literal-entry object-scope dispatchers were recognized.');
  return lines.join('\n')+'\n';
}
