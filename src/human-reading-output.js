import fs from 'node:fs/promises';
import path from 'node:path';
import {humanReading,humanReadingMarkdown} from './human-reading.js';
import {dispatcherMarkdown} from './dispatcher-reading.js';

export async function writeHumanReading(destination,fullCode,source){
  const root=path.resolve(destination),human=humanReading(fullCode,{dictionarySource:source});
  const write=async(file,text)=>{const target=path.resolve(root,file);if(!target.startsWith(root+path.sep))throw new Error('Reading output outside destination');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,text);};
  await write('src/human-reading.js',human.code);
  for(const table of human.tables)await write(table.file,JSON.stringify(table.data,null,2)+'\n');
  for(const item of human.internals)await write(item.file,item.code);
  for(const [i,machine] of human.dispatchers.machines.entries())if(machine.pathCode){
    machine.pathFile='src/reading-paths/'+String(i+1).padStart(3,'0')+'.js';await write(machine.pathFile,machine.pathCode);
  }
  await write('reports/HUMAN_READING.md',humanReadingMarkdown(human));
  await write('reports/HUMAN_READING.json',JSON.stringify({...human,code:undefined,tables:human.tables.map(({data,...row})=>row),internals:human.internals.map(({code,...row})=>row)},null,2)+'\n');
  await write('reports/DISPATCHERS.md',dispatcherMarkdown(human.dispatchers));
  await write('reports/DISPATCHERS.json',JSON.stringify(human.dispatchers,null,2)+'\n');
  return {human,model:{code:human.code,functions:human.functions,stats:human.stats,scope:human.scope,file:'src/human-reading.js',dispatchers:human.dispatchers}};
}
