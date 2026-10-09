export const UNKNOWN_NATIVE=Symbol('unknown native expression');
export const MAX_VALUE_LENGTH=100_000;
export const primitiveValue=value=>value===null||value===undefined||['string','number','boolean'].includes(typeof value);
export function boundedValue(value){
  return primitiveValue(value)?typeof value!=='string'||value.length<=MAX_VALUE_LENGTH
    :Array.isArray(value)&&value.length<=10_000&&value.every(primitiveValue)
      &&value.reduce((size,item)=>size+String(item).length,0)<=MAX_VALUE_LENGTH;
}
export const nativeFunctions={atob:globalThis.atob,btoa:globalThis.btoa,decodeURI,decodeURIComponent,
  encodeURI,encodeURIComponent,escape,unescape,parseInt:Number.parseInt,parseFloat:Number.parseFloat,
  String,Number,Boolean,isNaN,isFinite};
const strings={split:String.prototype.split,slice:String.prototype.slice,substring:String.prototype.substring,
  substr:String.prototype.substr,charAt:String.prototype.charAt,charCodeAt:String.prototype.charCodeAt,
  codePointAt:String.prototype.codePointAt,indexOf:String.prototype.indexOf,lastIndexOf:String.prototype.lastIndexOf,
  includes:String.prototype.includes,startsWith:String.prototype.startsWith,endsWith:String.prototype.endsWith,
  toLowerCase:String.prototype.toLowerCase,toUpperCase:String.prototype.toUpperCase,trim:String.prototype.trim,
  trimStart:String.prototype.trimStart,trimEnd:String.prototype.trimEnd,concat:String.prototype.concat,
  repeat:String.prototype.repeat,padStart:String.prototype.padStart,padEnd:String.prototype.padEnd,
  replace:String.prototype.replace,replaceAll:String.prototype.replaceAll};
const arrays={join:Array.prototype.join,slice:Array.prototype.slice,concat:Array.prototype.concat,
  indexOf:Array.prototype.indexOf,lastIndexOf:Array.prototype.lastIndexOf,includes:Array.prototype.includes,
  reverse:Array.prototype.reverse,push:Array.prototype.push,pop:Array.prototype.pop,shift:Array.prototype.shift,
  unshift:Array.prototype.unshift};
const mutating=new Set(['reverse','push','pop','shift','unshift']);
export const nativeMethodNames=new Set([...Object.keys(strings),...Object.keys(arrays),'toString']);
const math=new Set(['abs','floor','ceil','trunc','round','sign','min','max','pow','sqrt','imul','clz32']);
export const staticMethodNames={String:new Set(['fromCharCode','fromCodePoint']),Number:new Set(['parseInt','parseFloat','isFinite','isNaN','isInteger']),
  Math:math,Array:new Set(['isArray']),JSON:new Set(['parse','stringify'])};
const complete=value=>boundedValue(value)?value:UNKNOWN_NATIVE;
export function nativeCall(name,args){
  if(!Object.hasOwn(nativeFunctions,name)||!args.every(primitiveValue)||!args.every(boundedValue))return UNKNOWN_NATIVE;
  try{return complete(Reflect.apply(nativeFunctions[name],undefined,args));}catch{return UNKNOWN_NATIVE;}
}
export function nativeStatic(owner,method,args){
  if(!staticMethodNames[owner]?.has(method)||!args.every(boundedValue))return UNKNOWN_NATIVE;
  if(owner!=='Array'&&owner!=='JSON'&&!args.every(primitiveValue))return UNKNOWN_NATIVE;
  try{return complete(Reflect.apply(({String,Number,Math,Array,JSON})[owner][method],undefined,args));}catch{return UNKNOWN_NATIVE;}
}
export function nativeMethod(receiver,method,args,{mutable=false}={}){
  if(!boundedValue(receiver)||!args.every(boundedValue))return UNKNOWN_NATIVE;
  try{
    if(typeof receiver==='string'&&args.every(primitiveValue)&&Object.hasOwn(strings,method)){
      if(method==='repeat'&&(!Number.isInteger(+args[0])||+args[0]<0||+args[0]>MAX_VALUE_LENGTH||receiver.length*+args[0]>MAX_VALUE_LENGTH))return UNKNOWN_NATIVE;
      if(['padStart','padEnd'].includes(method)&&(+args[0]>MAX_VALUE_LENGTH||!Number.isFinite(+args[0])))return UNKNOWN_NATIVE;
      if(['replace','replaceAll'].includes(method)){
        if(args.length!==2||typeof args[0]!=='string'||typeof args[1]!=='string')return UNKNOWN_NATIVE;
        const occurrences=method==='replace'?1:args[0]===''?receiver.length+1:receiver.split(args[0]).length-1;
        // Replacement substitutions can insert a prefix, suffix or full match.
        const maximum=args[1].length+(args[1].includes('$')?receiver.length*args[1].length:0);
        if(receiver.length+occurrences*maximum>MAX_VALUE_LENGTH)return UNKNOWN_NATIVE;
      }
      return complete(Reflect.apply(strings[method],receiver,args));
    }
    if(Array.isArray(receiver)&&Object.hasOwn(arrays,method)){
      if(mutating.has(method)&&!mutable)return UNKNOWN_NATIVE;
      if(['push','unshift'].includes(method)&&(!args.every(primitiveValue)||receiver.length+args.length>10_000))return UNKNOWN_NATIVE;
      if(method==='join'&&(args.length>1||!args.every(primitiveValue)))return UNKNOWN_NATIVE;
      if(method==='join'&&receiver.length*String(args[0]??',').length+receiver.reduce((n,x)=>n+String(x??'').length,0)>MAX_VALUE_LENGTH)return UNKNOWN_NATIVE;
      return complete(Reflect.apply(arrays[method],receiver,args));
    }
    if(typeof receiver==='number'&&method==='toString'&&args.length<=1&&args.every(primitiveValue))return complete(receiver.toString(...args));
  }catch{}
  return UNKNOWN_NATIVE;
}
