import fs from 'node:fs/promises';
import path from 'node:path';

export const outputFiles = {
  'reader.html':'reader.html',
  'application.js':'src/application.js', 'readable.js':'src/readable.js', 'formatted.js':'src/formatted.js',
  'full-human-readable.js':'src/full-human-readable.js', 'short-human-readable.js':'src/short-human-readable.js', 'fingerprint-collection.js':'src/fingerprint-collection.js',
  'human-reading.js':'src/human-reading.js','human-reading-data':'src/reading-data','human-reading-internals':'src/reading-internals','reading-paths':'src/reading-paths',
  'HUMAN_READING.md':'reports/HUMAN_READING.md','HUMAN_READING.json':'reports/HUMAN_READING.json','DISPATCHERS.md':'reports/DISPATCHERS.md','DISPATCHERS.json':'reports/DISPATCHERS.json',
  'essentials.js':'src/essentials.js', 'tasks':'src/tasks',
  'modules':'src/modules','extracted-code':'src/extracted-code','functions':'src/functions',
  'FUNCTIONS.md':'reports/FUNCTIONS.md','FUNCTIONS.json':'reports/FUNCTIONS.json',
  'STRING_DECODERS.md':'reports/STRING_DECODERS.md','STRING_DECODERS.json':'reports/STRING_DECODERS.json',
  'READABILITY.md':'reports/READABILITY.md','READABILITY.json':'reports/READABILITY.json',
  ...Object.fromEntries(['ANALYSIS.md','behavior.json','BEHAVIOR.md','report.json','START_HERE.md','CODE_MAP.md','BRIEF.md','fingerprints.json','FINGERPRINTS.md','EMBEDDED_CODE.json','EMBEDDED_CODE.md'].map(name=>[name,'reports/'+name]))
};

// Migrate only recognized generated names. Keep conflicting old outputs in an
// archive instead of replacing a different file during this reversible move.
export async function organizeOutput(destination) {
  const root=path.resolve(destination);
  await fs.mkdir(path.join(root,'src'),{recursive:true});
  await fs.mkdir(path.join(root,'reports'),{recursive:true});
  for(const [oldName,newName] of Object.entries(outputFiles)) {
    if(oldName===newName)continue;
    const oldPath=path.resolve(root,oldName),newPath=path.resolve(root,newName);
    if(!oldPath.startsWith(root+path.sep)||!newPath.startsWith(root+path.sep))throw new Error('Output path outside destination');
    try{await fs.lstat(oldPath);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    let target=newPath;
    try{await fs.lstat(target);
      const archive=path.join(root,'reports','previous-layout');await fs.mkdir(archive,{recursive:true});
      target=path.join(archive,oldName);
      let suffix=1;
      for(;;){try{await fs.lstat(target);target=path.join(archive,oldName+'.'+suffix++);}catch(e){if(e.code==='ENOENT')break;throw e;}}
    }catch(e){if(e.code!=='ENOENT')throw e;}
    await fs.rename(oldPath,target);
  }
}
