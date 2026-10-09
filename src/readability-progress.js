import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {hexadecimalName,opaqueName} from './binding-names.js';
import {protectedGlobalBindings} from './global-renaming.js';
const traverse=traverseModule.default??traverseModule;
export function readabilityProfile(source){
  const ast=parse(source,{sourceType:'unambiguous'}),protectedBindings=protectedGlobalBindings(ast),seen=new Set();
  const result={hexBindings:0,shortBindings:0,computedProperties:0,switches:0,stringCodeSites:0,examples:[]};
  traverse(ast,{
    Scopable(p){for(const binding of Object.values(p.scope.bindings)){
      if(seen.has(binding))continue;seen.add(binding);const name=binding.identifier.name;
      if(hexadecimalName(name))result.hexBindings++;else if(opaqueName(name))result.shortBindings++;
      if(opaqueName(name)&&result.examples.length<24)result.examples.push({name,line:binding.identifier.loc?.start.line??null,
        reason:protectedBindings.has(binding)?'Observable global or inspected function/class name is preserved':'No unambiguous role inferred'});
    }},
    MemberExpression(p){if(p.node.computed&&!t.isStringLiteral(p.node.property)&&!t.isNumericLiteral(p.node.property))result.computedProperties++;},
    SwitchStatement(){result.switches++;},
    'CallExpression|NewExpression'(p){if(t.isIdentifier(p.node.callee)&&['eval','Function','setTimeout','setInterval'].includes(p.node.callee.name))result.stringCodeSites++;}
  });
  return result;
}
export function progressMarkdown(report,stats){
  const rows=[['Hexadecimal binding names','hexBindings'],['Other short binding names','shortBindings'],['Computed property expressions','computedProperties'],['Switch statements','switches'],['Possible string-code call sites','stringCodeSites']];
  return ['# Readability progress','',report.scope,'','| Syntax pattern | Input | Cleaned program |','|---|---:|---:|',
    ...rows.map(([label,key])=>`| ${label} | ${report.before[key]} | ${report.after[key]} |`),
    '',`Primitive helper calls decoded: ${stats.advanced.helperCalls}. Native literal calls folded: ${stats.advanced.literalCalls}.`,
    `Dispatchers expanded: ${stats.advanced.dispatchers+stats.advanced.stateDispatchers}. Constant switches simplified: ${stats.advanced.constantSwitches}.`,
    `Zero-iteration loops removed: ${stats.advanced.deadLoops}. Single-iteration do loops expanded: ${stats.advanced.singleIterationLoops}.`,
    '', '## Remaining names', '',...report.after.examples.map(example=>`- ${example.name} at cleaned line ${example.line??'unknown'}: ${example.reason}.`)].join('\n')+'\n';
}
