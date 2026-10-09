import * as t from '@babel/types';
// A rename plan must be visible before its edit is applied. Preserve reuse in
// unrelated functions while preventing capture between parent/child scopes.
export function reserveName(binding,wanted,registry){
 if(!t.isValidIdentifier(wanted))throw new Error('Invalid suggested binding name: '+wanted);
 const state=scope=>{let item=registry.get(scope);if(!item){item={used:null,reserved:new Set(),planned:new Set()};registry.set(scope,item);}return item;};
 const own=state(binding.scope);
 if(!own.used){own.used=new Set([...Object.keys(binding.scope.bindings),...own.reserved]);binding.scope.path.traverse({Identifier(p){if(p.isReferencedIdentifier()||p.isBindingIdentifier())own.used.add(p.node.name);}});}
 const ancestorPlan=name=>{for(let scope=binding.scope.parent;scope;scope=scope.parent)if(registry.get(scope)?.planned.has(name))return true;return false;};
 let name=wanted,suffix=2;while(own.used.has(name)||binding.scope.hasBinding(name)||ancestorPlan(name)||!t.isValidIdentifier(name))name=wanted+suffix++;
 own.used.add(name);own.planned.add(name);
 for(let scope=binding.scope.parent;scope;scope=scope.parent){const parent=state(scope);parent.reserved.add(name);parent.used?.add(name);}
 return name;
}
