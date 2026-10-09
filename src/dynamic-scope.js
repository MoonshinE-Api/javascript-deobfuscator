import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule;
export const inWith=p=>!!p.findParent(owner=>owner.isWithStatement());

// A with body can resolve names through an object. Preserve each lexical
// binding it can reach, but do not disable unrelated functions in the file.
// Direct eval retains the stronger ancestor-scope barrier.
export function dynamicBindings(ast){
  const unsafe=new Set(),evalScopes=new Set();
  traverse(ast,{
    CallExpression(p){if(t.isIdentifier(p.node.callee,{name:'eval'}))for(let scope=p.scope;scope;scope=scope.parent)evalScopes.add(scope);},
    ReferencedIdentifier(p){if(inWith(p)){const binding=p.scope.getBinding(p.node.name);if(binding)unsafe.add(binding);}},
    Identifier(p){if(inWith(p)&&p.isBindingIdentifier()){const binding=p.scope.getBinding(p.node.name);if(binding)unsafe.add(binding);}},
    AssignmentExpression(p){if(inWith(p))for(const name of Object.keys(t.getAssignmentIdentifiers(p.node))){const binding=p.scope.getBinding(name);if(binding)unsafe.add(binding);}},
    Scopable(p){if(inWith(p))for(const binding of Object.values(p.scope.bindings))unsafe.add(binding);}
  });
  traverse(ast,{Scopable(p){if(evalScopes.has(p.scope))for(const binding of Object.values(p.scope.bindings))unsafe.add(binding);}});
  return unsafe;
}
