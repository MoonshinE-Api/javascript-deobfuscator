import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule;
const returned=p=>p.isReturnStatement()?p.node:p.isBlockStatement()&&p.node.body.length===1&&t.isReturnStatement(p.node.body[0])?p.node.body[0]:null;
const truthy=node=>t.isUnaryExpression(node,{operator:'!'})||t.isBinaryExpression(node)&&['===','!==','==','!=','<','>','<=','>=','in','instanceof'].includes(node.operator)
  ?node:t.unaryExpression('!',t.unaryExpression('!',node));

// Compact proven boolean-return patterns, without deleting unseen behavior.
export function shorten(ast){
  const stats={booleanReturns:0,expressionArrows:0,shorthandProperties:0};let dynamic=false;
  traverse(ast,{CallExpression(p){if(t.isIdentifier(p.node.callee,{name:'eval'}))dynamic=true;}});
  if(dynamic)return {...stats,skipped:'Dynamic scope can observe source structure.'};
  traverse(ast,{
    WithStatement(p){p.skip();},
    IfStatement(p){
      const yes=returned(p.get('consequent')),alternate=p.node.alternate?returned(p.get('alternate')):null;
      const sibling=!alternate&&p.inList?p.getSibling(p.key+1):null;
      const no=alternate??(sibling?.isReturnStatement()?sibling.node:null);
      if(!t.isBooleanLiteral(yes?.argument)||!t.isBooleanLiteral(no?.argument)||yes.argument.value===no.argument.value)return;
      const expression=yes.argument.value?truthy(t.cloneNode(p.node.test,true)):t.unaryExpression('!',t.cloneNode(p.node.test,true));
      const result=t.returnStatement(expression);t.inheritsComments(result,p.node);t.inheritsComments(result,yes);t.inheritsComments(result,no);
      p.replaceWith(result);if(!alternate)sibling.remove();stats.booleanReturns++;
    },
    ArrowFunctionExpression(p){if(t.isBlockStatement(p.node.body)&&p.node.body.body.length===1&&t.isReturnStatement(p.node.body.body[0])&&p.node.body.body[0].argument){
      const statement=p.node.body.body[0];p.node.body=t.inheritsComments(statement.argument,statement);stats.expressionArrows++;
    }},
    ObjectProperty(p){const n=p.node;if(!n.computed&&!n.shorthand&&t.isIdentifier(n.key)&&t.isIdentifier(n.value,{name:n.key.name})&&n.key.name!=='__proto__'){
      n.shorthand=true;stats.shorthandProperties++;
    }}
  });return stats;
}
