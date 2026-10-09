import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {dynamicBindings} from './dynamic-scope.js';
const traverse=traverseModule.default??traverseModule;

// Global-name observers cannot be rewritten by lexical binding renaming:
// indirect eval, generated functions and window/globalThis property access.
// Keep script globals stable while still inferring names inside local scopes.
export function protectedGlobalBindings(ast){
 let observed=false,nameObserved=false,program;const protectedBindings=dynamicBindings(ast);
 const protectObject=p=>{if(t.isIdentifier(p.node)){
  let binding=p.scope.getBinding(p.node.name);const seen=new Set();
  while(binding&&!seen.has(binding)){
   seen.add(binding);protectedBindings.add(binding);
   if(!binding.constant||!binding.path.isVariableDeclarator()||!t.isIdentifier(binding.path.node.init))break;
   binding=binding.path.scope.getBinding(binding.path.node.init.name);
  }
 }};
 traverse(ast,{Program(p){program=p;},ReferencedIdentifier(p){
   if(['globalThis','window','self','eval','Function'].includes(p.node.name)&&!p.scope.getBinding(p.node.name))observed=true;
 },MemberExpression(p){
   if(p.node.computed?t.isStringLiteral(p.node.property,{value:'name'}):t.isIdentifier(p.node.property,{name:'name'})){
    nameObserved=true;protectObject(p.get('object'));
   }
 },CallExpression(p){
   if(t.isMemberExpression(p.node.callee)&&t.isStringLiteral(p.node.arguments[1],{value:'name'})
    &&['get','getOwnPropertyDescriptor','defineProperty'].includes(p.node.callee.property.name??p.node.callee.property.value)){
    nameObserved=true;protectObject(p.get('arguments.0'));
   }
 }});
 if(observed&&program?.node.sourceType!=='module')for(const binding of Object.values(program.scope.bindings))protectedBindings.add(binding);
 // Function.name can flow through aliases/factories. Keep function/class
 // binding names stable when any name inspection is present, rather than
 // guessing which factory result a dynamic expression will produce.
 if(nameObserved)traverse(ast,{Scopable(p){for(const binding of Object.values(p.scope.bindings)){
   if(binding.path.isFunction()||binding.path.isClass()
    ||binding.path.isVariableDeclarator()&&(t.isFunction(binding.path.node.init)||t.isClassExpression(binding.path.node.init)))protectedBindings.add(binding);
 }}});
 return protectedBindings;
}
