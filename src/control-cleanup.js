import * as t from '@babel/types';
import {primitiveLiteral,UNKNOWN_LITERAL} from './clean-junk.js';
function hoistedVars(node){
  const names=new Set();let unsupported=false;
  function walk(n){
    if(!n)return;if(t.isFunctionDeclaration(n)){unsupported=true;return;}if(t.isFunction(n))return;
    if(t.isVariableDeclaration(n)&&n.kind==='var')for(const d of n.declarations)for(const name of Object.keys(t.getBindingIdentifiers(d.id)))names.add(name);
    for(const field of t.VISITOR_KEYS[n.type]??[]){const child=n[field];if(Array.isArray(child))child.forEach(walk);else walk(child);}
  }walk(node);return {names:[...names],unsupported};
}
const vars=names=>names.length?[t.variableDeclaration('var',names.map(name=>t.variableDeclarator(t.identifier(name))))]:[];
function nearestControl(p){for(let owner=p.parentPath;owner;owner=owner.parentPath){if(owner.isFunction())return null;if(owner.isLoop()||owner.isSwitchStatement())return owner;}return null;}
function freshLabel(p,name){
  const labels=new Set();(p.getFunctionParent()??p.scope.getProgramParent().path).traverse({LabeledStatement(q){labels.add(q.node.label.name);}});
  let label=p.scope.generateUidIdentifier(name);while(labels.has(label.name))label=p.scope.generateUidIdentifier(name);return label;
}
export function constantSwitch(p){
  const value=primitiveLiteral(p.node.discriminant);if(value===UNKNOWN_LITERAL)return null;
  const keys=p.node.cases.map(entry=>entry.test?primitiveLiteral(entry.test):null);
  if(keys.includes(UNKNOWN_LITERAL)||p.node.cases.some(entry=>entry.consequent.some(n=>t.isFunctionDeclaration(n)||t.isClassDeclaration(n)||t.isVariableDeclaration(n)&&n.kind!=='var')))return null;
  const hoists=hoistedVars(p.node);if(hoists.unsupported)return null;
  let start=p.node.cases.findIndex((entry,i)=>entry.test&&keys[i]===value);
  if(start<0)start=p.node.cases.findIndex(entry=>!entry.test);
  const selected=start<0?[]:p.node.cases.slice(start).flatMap(entry=>entry.consequent);
  const label=freshLabel(p,'switchExit');let breaks=false;
  p.traverse({BreakStatement(q){if(!q.node.label&&nearestControl(q)===p){q.node.label=t.cloneNode(label);breaks=true;}}});
  const block=t.blockStatement([...vars(hoists.names),...selected.map(n=>t.cloneNode(n,true))]);
  return breaks?t.labeledStatement(label,block):block;
}
export function constantLoop(p){
  const n=p.node;if(!n.test)return null;
  const value=primitiveLiteral(n.test);if(value===UNKNOWN_LITERAL||value)return null;
  const hoists=hoistedVars(n.body);if(hoists.unsupported)return null;
  if(t.isDoWhileStatement(n)){
    if(p.parentPath.isLabeledStatement())return null;
    const label=freshLabel(p,'loopExit');let jumps=false;
    p.traverse({'BreakStatement|ContinueStatement'(q){if(!q.node.label&&nearestControl(q)===p){q.replaceWith(t.breakStatement(t.cloneNode(label)));jumps=true;}}});
    const block=t.blockStatement([t.cloneNode(n.body,true)]);return jumps?t.labeledStatement(label,block):block;
  }
  const init=t.isForStatement(n)&&n.init?(t.isVariableDeclaration(n.init)?t.cloneNode(n.init,true):t.expressionStatement(t.cloneNode(n.init,true))):null;
  return t.blockStatement([...vars(hoists.names),...(init?[init]:[]),t.expressionStatement(t.unaryExpression('void',t.numericLiteral(0)))]);
}
