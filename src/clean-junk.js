import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule,unknown=Symbol('unknown');

// Evaluate literal primitives only, never object coercion, getters or calls.
function literal(node,depth=0){
 if(!node||depth>80)return unknown;
 if(t.isNumericLiteral(node)||t.isStringLiteral(node)||t.isBooleanLiteral(node))return node.value;
 if(t.isNullLiteral(node))return null;
 if(t.isUnaryExpression(node,{operator:'!'})&&(t.isArrayExpression(node.argument)&&node.argument.elements.every(n=>n&&literal(n,depth+1)!==unknown)
   ||t.isObjectExpression(node.argument)&&node.argument.properties.every(p=>t.isObjectProperty(p)&&!p.computed&&literal(p.value,depth+1)!==unknown)))return false;
 const get=n=>literal(n,depth+1);
 if(t.isUnaryExpression(node)){const a=get(node.argument);if(a===unknown)return unknown;switch(node.operator){case '+':return +a;case '-':return -a;case '!':return !a;case '~':return ~a;case 'typeof':return typeof a;case 'void':return undefined;default:return unknown;}}
 if(t.isBinaryExpression(node)){const a=get(node.left),b=get(node.right);if(a===unknown||b===unknown)return unknown;
   switch(node.operator){case '+':return a+b;case '-':return a-b;case '*':return a*b;case '/':return a/b;case '%':return a%b;case '**':return a**b;case '|':return a|b;case '&':return a&b;case '^':return a^b;case '<<':return a<<b;case '>>':return a>>b;case '>>>':return a>>>b;case '===':return a===b;case '!==':return a!==b;case '==':return a==b;case '!=':return a!=b;case '<':return a<b;case '>':return a>b;case '<=':return a<=b;case '>=':return a>=b;default:return unknown;}}
 if(t.isLogicalExpression(node)){const a=get(node.left),b=get(node.right);if(a===unknown||b===unknown)return unknown;return node.operator==='&&'?a&&b:node.operator==='||'?a||b:a??b;}
 if(t.isConditionalExpression(node)){const a=get(node.test),b=get(node.consequent),c=get(node.alternate);return [a,b,c].includes(unknown)?unknown:a?b:c;}
 return unknown;
}
const replacement=value=>value===undefined?t.unaryExpression('void',t.numericLiteral(0)):typeof value==='number'&&(!Number.isFinite(value)||Object.is(value,-0))?null:typeof value==='string'&&value.length>8192?null:t.valueToNode(value);
export {literal as primitiveLiteral,unknown as UNKNOWN_LITERAL};

export function cleanJunk(source){
 const ast=parse(source,{sourceType:'unambiguous'}),stats={foldedArithmetic:0,removedLiteralStatements:0,removedUnusedLocals:0,skipped:null};let dynamic=false;
 traverse(ast,{WithStatement(){dynamic=true;},CallExpression(p){if(t.isIdentifier(p.node.callee,{name:'eval'}))dynamic=true;}});
 if(dynamic){stats.skipped='Direct eval or with: local cleanup disabled';return {code:source,stats};}
 traverse(ast,{
  'BinaryExpression|UnaryExpression|LogicalExpression|ConditionalExpression':{exit(p){const value=literal(p.node);if(value===unknown)return;const node=replacement(value);if(!node||t.isNodesEquivalent(node,p.node))return;t.inheritsComments(node,p.node);p.replaceWith(node);stats.foldedArithmetic++;}},
  ExpressionStatement:{exit(p){
   // Script completion values (including eval return values) are observable.
   // Remove discarded literals only inside ordinary function bodies.
   if(!p.getFunctionParent()||literal(p.node.expression)===unknown)return;
   if(p.parentPath.isLabeledStatement()||!p.inList)return;p.remove();stats.removedLiteralStatements++;
  }}
 });
 traverse(ast,{Program(p){p.scope.crawl();p.stop();}});
 traverse(ast,{VariableDeclarator(p){
   if(!t.isIdentifier(p.node.id)||!p.getFunctionParent())return;
   const declaration=p.parentPath;if(!declaration.isVariableDeclaration()||!declaration.inList||!declaration.parentPath.isBlockStatement())return;
   const binding=p.scope.getBinding(p.node.id.name);if(!binding||binding.referenced||binding.constantViolations.length||binding.path!==p)return;
   if(p.node.init&&literal(p.node.init)===unknown)return;
   // Preserve declarations inside switch/loop headers and all destructuring.
   p.remove();if(declaration.node?.declarations.length===0)declaration.remove();stats.removedUnusedLocals++;
 }});
 const code=generate(ast,{comments:true,jsescOption:{minimal:true}}).code+'\n';parse(code,{sourceType:'unambiguous'});return {code,stats};
}

export function shortReading(source,file){
 const ast=parse(source,{sourceType:'unambiguous'}),sites=[],seen=new Set();
 const interesting=new Set(['fetch','sendBeacon','open','send','setRequestHeader','getItem','setItem','getContext','toDataURL','getImageData','getParameter','getExtension','readPixels','encrypt','decrypt','digest','importKey','exportKey','postMessage','importScripts','addEventListener','Worker','SharedWorker','WebSocket']);
 const chain=n=>t.isIdentifier(n)?n.name:t.isMemberExpression(n)?chain(n.object)+'.'+(t.isIdentifier(n.property)&&!n.computed?n.property.name:t.isStringLiteral(n.property)?n.property.value:'[computed]'):'';
 traverse(ast,{noScope:true,'CallExpression|NewExpression'(p){const target=chain(p.node.callee),name=target.split('.').at(-1);if(!interesting.has(name)||sites.length>=160)return;
   const key=target+':'+p.node.loc.start.line;if(seen.has(key))return;seen.add(key);
   const code=generate(p.node,{concise:true,comments:false}).code.slice(0,500);sites.push({target,file,line:p.node.loc.start.line,column:p.node.loc.start.column+1,endLine:p.node.loc.end.line,formatted:true,code,basis:'Static operation in the complete cleaned source; it may not execute.'});
 }});
 const text=['// Short reading extract. It cannot replace or run as the complete program.', '// Line numbers refer to '+file+'. Open the full source for surrounding state.', ...sites.flatMap(s=>['', '// '+s.target+' — line '+s.line+':'+s.column,s.code])].join('\n')+'\n';
 return {sites,text};
}
