import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {statementLayout} from './statement-layout.js';
const traverse=traverseModule.default??traverseModule;
export function readableFlow(ast){
  const stats={expandedForHeaders:0,statements:statementLayout(ast)};let evalScope=false;
  traverse(ast,{CallExpression(p){if(t.isIdentifier(p.node.callee,{name:'eval'}))evalScope=true;}});
  if(evalScope)return stats;
  traverse(ast,{WithStatement(p){p.skip();},ForStatement:{exit(p){
    const init=p.node.init;
    if(!t.isVariableDeclaration(init,{kind:'var'})||init.declarations.length<2||p.parentPath.isLabeledStatement()||init.declarations.some(item=>!t.isIdentifier(item.id)))return;
    const loop=t.cloneNode(p.node,true);loop.init=null;
    const declarations=init.declarations.map(item=>t.variableDeclaration('var',[t.cloneNode(item,true)]));
    const block=t.blockStatement([...declarations,loop]);t.inheritsComments(block,p.node);p.replaceWith(block);stats.expandedForHeaders++;
  }}});return stats;
}
