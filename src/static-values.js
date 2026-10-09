import * as t from '@babel/types';
import {primitiveLiteral,UNKNOWN_LITERAL} from './clean-junk.js';
import {initializedFor} from './initialized-binding.js';
import {capturedValue,primitiveHelper,interpretHelper,UNKNOWN_HELPER} from './primitive-helpers.js';
import {nativeCall,nativeStatic,nativeMethod,boundedValue,primitiveValue,UNKNOWN_NATIVE} from './native-values.js';
export const UNKNOWN_STATIC=Symbol('unresolved static value');
export function valueNode(value){
  if(value===undefined)return t.unaryExpression('void',t.numericLiteral(0));
  if(typeof value==='number'){
    if(Object.is(value,-0))return t.unaryExpression('-',t.numericLiteral(0));
    if(Number.isNaN(value))return t.binaryExpression('/',t.numericLiteral(0),t.numericLiteral(0));
    if(!Number.isFinite(value))return t.binaryExpression('/',t.numericLiteral(value<0?-1:1),t.numericLiteral(0));
  }
  return Array.isArray(value)?t.arrayExpression(value.map(valueNode)):t.valueToNode(value);
}
export function staticValue(p,{bindings=true,seen=new Set(),depth=0,budget={steps:0}}={}){
  if(!p?.node||depth>80||++budget.steps>100_000)return UNKNOWN_STATIC;
  const n=p.node,read=child=>staticValue(child,{bindings,seen,depth:depth+1,budget});
  const literal=primitiveLiteral(n);if(literal!==UNKNOWN_LITERAL)return boundedValue(literal)?literal:UNKNOWN_STATIC;
  if(t.isIdentifier(n)&&bindings){
    const binding=p.scope.getBinding(n.name);
    if(!binding?.constant||!initializedFor(binding,p)||seen.has(binding))return UNKNOWN_STATIC;
    const captured=capturedValue(binding);if(captured!==UNKNOWN_HELPER)return captured;
    return staticValue(binding.path.get('init'),{bindings,seen:new Set([...seen,binding]),depth:depth+1,budget});
  }
  if(t.isArrayExpression(n)){
    if(n.elements.length>10_000||n.elements.some(item=>!item||t.isSpreadElement(item)))return UNKNOWN_STATIC;
    const values=p.get('elements').map(read);return values.every(primitiveValue)&&boundedValue(values)?values:UNKNOWN_STATIC;
  }
  if(t.isTemplateLiteral(n)){
    let value=n.quasis[0].value.cooked;
    for(let i=0;i<n.expressions.length;i++){const part=read(p.get(`expressions.${i}`));if(!primitiveValue(part))return UNKNOWN_STATIC;value+=String(part)+n.quasis[i+1].value.cooked;if(!boundedValue(value))return UNKNOWN_STATIC;}return value;
  }
  if(t.isBinaryExpression(n)||t.isUnaryExpression(n)){
    const a=read(p.get(t.isUnaryExpression(n)?'argument':'left'));if(!primitiveValue(a))return UNKNOWN_STATIC;
    let node;
    if(t.isUnaryExpression(n))node=t.unaryExpression(n.operator,valueNode(a));
    else{const b=read(p.get('right'));if(!primitiveValue(b))return UNKNOWN_STATIC;node=t.binaryExpression(n.operator,valueNode(a),valueNode(b));}
    const value=primitiveLiteral(node);return value!==UNKNOWN_LITERAL&&boundedValue(value)?value:UNKNOWN_STATIC;
  }
  if(t.isLogicalExpression(n)){const a=read(p.get('left'));if(!primitiveValue(a))return UNKNOWN_STATIC;
    return n.operator==='&&'?(a?read(p.get('right')):a):n.operator==='||'?(a?a:read(p.get('right'))):a??read(p.get('right'));}
  if(t.isConditionalExpression(n)){const a=read(p.get('test'));return primitiveValue(a)?read(p.get(a?'consequent':'alternate')):UNKNOWN_STATIC;}
  if(t.isMemberExpression(n)&&!n.optional){
    const value=read(p.get('object')),key=n.computed?read(p.get('property')):n.property.name;
    if(typeof value!=='string'&&!Array.isArray(value))return UNKNOWN_STATIC;
    if(key==='length')return value.length;
    return /^(0|[1-9]\d*)$/.test(String(key))?value[Number(key)]:UNKNOWN_STATIC;
  }
  if(t.isCallExpression(n)&&!n.optional&&!n.arguments.some(arg=>t.isSpreadElement(arg))){
    const args=p.get('arguments').map(read);if(args.some(value=>value===UNKNOWN_STATIC)||!args.every(boundedValue))return UNKNOWN_STATIC;
    let value=UNKNOWN_NATIVE;
    if(t.isIdentifier(n.callee)){
      const binding=p.scope.getBinding(n.callee.name);
      if(!binding)value=nativeCall(n.callee.name,args);
      else if(bindings){
        const helper=primitiveHelper(binding);
        if(helper&&helper.requirements.every(required=>required.path.isFunctionDeclaration()||initializedFor(required,p))){const result=interpretHelper(helper,args);if(result!==UNKNOWN_HELPER)return result;}
      }
    }else if(t.isMemberExpression(n.callee)&&!n.callee.optional){
      const c=n.callee,method=c.computed?read(p.get('callee.property')):c.property.name;
      if(t.isIdentifier(c.object)&&!p.scope.getBinding(c.object.name))value=nativeStatic(c.object.name,method,args);
      if(value===UNKNOWN_NATIVE){const receiver=read(p.get('callee.object'));if(receiver!==UNKNOWN_STATIC)value=nativeMethod(Array.isArray(receiver)?receiver.slice():receiver,method,args,{mutable:Array.isArray(receiver)});}
    }
    return value===UNKNOWN_NATIVE?UNKNOWN_STATIC:value;
  }
  return UNKNOWN_STATIC;
}
