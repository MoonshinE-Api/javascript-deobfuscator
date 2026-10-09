import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule;

// These edits change statement layout, not name resolution. In particular they
// are valid inside `with`: no bindings or lexical declarations are introduced.
export function statementLayout(ast){
  const stats={sequences:0,returns:0,throws:0,declarations:0};
  const install=(p,nodes)=>{
    t.inheritsComments(nodes[0],p.node);
    if(p.inList)p.replaceWithMultiple(nodes);else p.replaceWith(t.blockStatement(nodes));
  };
  const expression=node=>{
    // A bare string at the beginning of a function could become a directive.
    // Parentheses preserve both its value and its non-directive status.
    return t.expressionStatement(t.isStringLiteral(node)?t.parenthesizedExpression(node):node);
  };
  traverse(ast,{
    ExpressionStatement:{exit(p){
      if(!t.isSequenceExpression(p.node.expression))return;
      install(p,p.node.expression.expressions.map(expression));stats.sequences++;
    }},
    'ReturnStatement|ThrowStatement':{exit(p){
      if(!t.isSequenceExpression(p.node.argument))return;
      const parts=p.node.argument.expressions,tail=parts.at(-1);
      const last=p.isReturnStatement()?t.returnStatement(tail):t.throwStatement(tail);
      const kind=p.isReturnStatement()?'returns':'throws';
      install(p,[...parts.slice(0,-1).map(expression),last]);stats[kind]++;
    }},
    VariableDeclaration:{exit(p){
      if(p.node.kind!=='var'||p.node.declarations.length<2||!p.inList)return;
      install(p,p.node.declarations.map(d=>t.variableDeclaration('var',[d])));stats.declarations++;
    }}
  });
  return stats;
}
