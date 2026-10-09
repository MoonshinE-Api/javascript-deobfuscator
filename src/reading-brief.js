import {parse,parseExpression} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
const traverse=traverseModule.default??traverseModule,generate=generatorModule.default??generatorModule;
const taskNames={setConfig:'Change the settings',getConfig:'Read the settings',run:'Start the main action',reset:'Reset the state',dataResponse:'Handle a data response',version:'Read the version'};
const descriptions={setConfig:'Applies settings supplied by the website.',getConfig:'Returns the current settings.',run:'Starts the main action. Follow the next function to see what happens.',reset:'Asks the client to reset its current state.',dataResponse:'Passes a data response on for processing.',version:'Shows the client version.'};
export function addBrief(model){
  for(const card of model.cards){
    card.friendlyName=taskNames[card.name]??card.name.replace(/([a-z])([A-Z])/g,'$1 $2');
    card.friendlySummary=descriptions[card.name]??card.summary;
    card.focus=[];let ast;
    try{ast=parse(card.code,{sourceType:'unambiguous',allowReturnOutsideFunction:true});}
    catch{try{ast=parse(`({${card.code}})`);}catch{continue;}}
    const seen=new Set();
    const add=(node,title)=>{const code=generate(node,{comments:false}).code;if(code.length>650||seen.has(code)||card.focus.length>=6)return;seen.add(code);
      card.focus.push({title,code,file:model.sourceFile,line:card.line+(node.loc?.start.line??1)-1});};
    traverse(ast,{
      CallExpression(p){const n=p.node.callee;
        if(t.isIdentifier(n)&&/^(define|assertClass|toPrimitive|typeOf|mergeObjects|advanceAsync|cloneValue)/.test(n.name))return;
        add(p.node,'A call made by this function');},
      AssignmentExpression(p){if(t.isMemberExpression(p.node.left))add(p.node,'A value changed by this function');},
      ReturnStatement(p){if(p.node.argument&&!t.isCallExpression(p.node.argument))add(p.node,'A result returned by this function');}
    });
  }
  return model;
}
export function briefMarkdown(model){
  const lines=['# Short reading view','','Open [reader.html](../reader.html) for clickable explanations. These are real code excerpts, not a replacement script.',''];
  for(const task of model.behavior?.journeys??[]){const card=model.cards.find(c=>c.id===task.entryId),target=card?.focus.length?card:model.cards.find(c=>c.id===card?.links[0]?.id);
    lines.push('## '+(card?.friendlyName??task.title),'',task.summary,'');
    for(const part of target?.focus.slice(0,2)??[])lines.push(`${part.file}, line ${part.line}:`,'','```js',part.code,'```','');
  }
  lines.push('Shared variables, conditions, callbacks, and omitted helpers are retained in the full source. Excerpts cannot be run on their own.','');
  return lines.join('\n');
}

export function taskExtracts(model){
  const files=[],properties=[],used=new Set();
  const notice='// Reading extract: real task code, with surrounding helpers and shared state omitted.\n// This file is not a standalone replacement. Use readable.js for the complete program.\n';
  for(const task of model.behavior?.journeys??[]){
    const entry=model.cards.find(c=>c.id===task.entryId);
    const target=entry?.links.length?model.cards.find(c=>c.id===entry.links[0].id):entry;
    if(!target)continue;let expression;
    try{expression=parseExpression(target.code);}catch{
      try{const property=parseExpression(`({${target.code}})`).properties[0];
        if(t.isObjectMethod(property))expression=t.functionExpression(null,property.params,property.body,property.generator,property.async);
        else if(t.isObjectProperty(property))expression=property.value;
      }catch{continue;}
    }
    if(!t.isFunctionExpression(expression)&&!t.isArrowFunctionExpression(expression)&&!t.isLiteral(expression))continue;
    const base=task.title.replace(/([a-z])([A-Z])/g,'$1-$2').toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/^-+|-+$/g,'')||'task';
    let slug=base,suffix=1;while(used.has(slug))slug=base+'-'+suffix++;used.add(slug);
    const file='src/tasks/'+slug+'.js';
    files.push({file,code:notice+generate(t.exportDefaultDeclaration(t.cloneNode(expression,true)),{comments:true}).code+'\n'});
    entry.taskFile=file;target.taskFile=file;
    properties.push(t.objectProperty(t.stringLiteral(task.title),t.cloneNode(expression,true)));
  }
  const code=notice+generate(t.exportDefaultDeclaration(t.objectExpression(properties)),{comments:true}).code+'\n';
  model.taskReading={file:'src/essentials.js',lines:code.split('\n').length,files:files.map(f=>f.file)};
  files.push({file:model.taskReading.file,code});return files;
}
