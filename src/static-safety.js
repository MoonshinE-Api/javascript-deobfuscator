import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule;
export const STATIC_BUILTINS=new Set(['String','Array','Object','Number','Math','JSON','atob','btoa',
  'decodeURI','decodeURIComponent','encodeURI','encodeURIComponent','parseInt','parseFloat','escape','unescape']);
const globals=new Set(['globalThis','window','self']);
const key=n=>n?.computed?(t.isStringLiteral(n.property)?n.property.value:null):n?.property?.name;
export function staticSafety(ast,{ignoreDynamicCode=false}={}){
  let dynamic=false,directEval=false,intrinsicsChanged=false,globalWrites=false;
  const root=n=>{while(t.isMemberExpression(n))n=n.object;return n;};
  const origin=(n,scope,seen=new Set())=>{
    if(!n||seen.size>20)return null;
    if(t.isIdentifier(n)){
      const binding=scope.getBinding(n.name);
      if(!binding)return globals.has(n.name)?'global':STATIC_BUILTINS.has(n.name)?'builtin':null;
      if(!binding.constant||!binding.path.isVariableDeclarator()||seen.has(binding))return null;
      return origin(binding.path.node.init,binding.path.scope,new Set([...seen,binding]));
    }
    if(t.isMemberExpression(n)){
      const owner=origin(n.object,scope,seen);return owner==='builtin'?'builtin':owner==='global'&&STATIC_BUILTINS.has(key(n))?'builtin':null;
    }return null;
  };
  const isGlobal=(n,p)=>origin(n,p.scope)==='global';
  const isBuiltin=(n,p)=>origin(n,p.scope)==='builtin';
  const write=(n,p)=>{
    if(isGlobal(root(n),p)){
      globalWrites=true;let first=n;while(t.isMemberExpression(first)&&t.isMemberExpression(first.object))first=first.object;
      if(!t.isMemberExpression(first)||key(first)==null||STATIC_BUILTINS.has(key(first)))intrinsicsChanged=true;
    }
    if(isBuiltin(n,p))intrinsicsChanged=true;
  };
  traverse(ast,{
    WithStatement(){dynamic=true;},
    ReferencedIdentifier(p){
      if(['eval','Function'].includes(p.node.name)&&!p.scope.getBinding(p.node.name)){globalWrites=true;if(!ignoreDynamicCode)intrinsicsChanged=true;}
      if(STATIC_BUILTINS.has(p.node.name)&&!p.scope.getBinding(p.node.name)){
        const owner=p.parentPath;
        if(!(owner.isMemberExpression()&&owner.node.object===p.node||owner.isCallExpression()&&owner.node.callee===p.node))intrinsicsChanged=true;
      }
    },
    'CallExpression|NewExpression'(p){
      if(t.isIdentifier(p.node.callee,{name:'eval'}))dynamic=directEval=true;
      const c=p.node.callee;
      if(t.isMemberExpression(c)&&key(c)==='getPrototypeOf'&&t.isIdentifier(c.object,{name:'Object'})&&!p.scope.getBinding('Object'))intrinsicsChanged=true;
      if(t.isMemberExpression(c)&&['defineProperty','defineProperties','setPrototypeOf','assign','set','deleteProperty'].includes(key(c)))
        write(p.node.arguments[0],p);
    },
    AssignmentExpression(p){for(const node of Object.values(t.getAssignmentIdentifiers(p.node)))write(node,p);write(p.node.left,p);},
    UpdateExpression(p){write(p.node.argument,p);},
    UnaryExpression(p){if(p.node.operator==='delete')write(p.node.argument,p);},
    MemberExpression(p){
      if(key(p.node)==='prototype'&&(isBuiltin(p.node.object,p)||t.isMemberExpression(p.node.object)&&key(p.node.object)==='constructor'))intrinsicsChanged=true;
      if(['eval','Function'].includes(key(p.node))&&isGlobal(p.node.object,p)){globalWrites=true;if(!ignoreDynamicCode)intrinsicsChanged=true;}
    }
  });
  return {dynamic,directEval,intrinsicsChanged,globalWrites};
}
