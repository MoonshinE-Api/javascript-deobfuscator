import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule;

// Name inference used to traverse an entire scope once per suggested name.
// Resolve all identifiers against the old binding table, then apply the edits
// together. Shadowed bindings and public property names remain distinct.
export function batchRename(ast,plans){
 if(!plans.size)return;
 let active=new Map(plans);const byIdentifier=new Map(),edits=new Map(),references=[];let splitExports=false;
 for(const [binding,name] of active){
   const declaration=binding.path.find(p=>p.isDeclaration()||p.isFunctionExpression()||p.isClassExpression());
   if(declaration?.parentPath.isExportDeclaration()){
     binding.scope.rename(binding.identifier.name,name);active.delete(binding);splitExports=true;
   }
 }
 if(splitExports){
   // Splitting an exported declaration can move its function path to a new
   // scope. Rebind remaining plans to the live declaration identifiers.
   const wanted=new Map([...active].map(([binding,name])=>[binding.identifier,name])),live=new Map();
   traverse(ast,{Program(p){p.scope.crawl();p.stop();}});
   traverse(ast,{Scopable(p){for(const binding of Object.values(p.scope.bindings))if(wanted.has(binding.identifier))live.set(binding,wanted.get(binding.identifier));}});active=live;
 }
 for(const [binding,name] of active)byIdentifier.set(binding.identifier,name);
 const target=(scope,name)=>byIdentifier.get(scope.getBinding(name)?.identifier);
 traverse(ast,{
   ObjectProperty(p){if(!p.node.shorthand||!target(p.scope,p.node.value.name??p.node.value.left?.name))return;
     if(p.node.key===p.node.value)p.node.key=t.cloneNode(p.node.key);
     p.node.shorthand=false;if(p.node.extra)p.node.extra.shorthand=false;
   },
   Identifier(p){
     // Labels have their own namespace. A local variable with the same spelling
     // must never rename the target of a labeled break/continue.
     if(p.key==='label'&&(p.parentPath.isLabeledStatement()||p.parentPath.isBreakStatement()||p.parentPath.isContinueStatement()))return;
     if(p.parentPath.isExportSpecifier()&&p.key==='exported'||p.parentPath.isImportSpecifier()&&p.key==='imported')return;
     if(p.isReferencedIdentifier())references.push([p.node,p.scope,p.scope.getBinding(p.node.name)?.identifier??null]);
     if(!p.isReferencedIdentifier()&&!p.isBindingIdentifier())return;const name=byIdentifier.get(p.node)??target(p.scope,p.node.name);if(name)edits.set(p.node,name);
   },
   AssignmentExpression(p){for(const [name,node] of Object.entries(t.getAssignmentIdentifiers(p.node))){const next=target(p.scope,name);if(next)edits.set(node,next);}}
 });
 for(const [node,name] of edits)node.name=name;
 for(const [binding,name] of active){for(const [old,value] of Object.entries(binding.scope.bindings))if(value===binding)delete binding.scope.bindings[old];binding.scope.bindings[name]=binding;binding.identifier.name=name;}
 for(const [node,scope,expected] of references)if((scope.getBinding(node.name)?.identifier??null)!==expected)throw new Error('Batch naming changed an identifier binding ('+node.name+'); refusing to retain renamed code.');
}
