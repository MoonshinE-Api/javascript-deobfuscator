import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unpack} from '../index.js';
import {buildInformation} from '../src/information.js';

const project=fileURLToPath(new URL('../',import.meta.url));
test('offline package has no capture runtime or runtime execution dependencies',async()=>{
  const files=await fs.readdir(path.join(project,'src'));
  assert.ok(!files.some(file=>/^(capture|session|browser-|trace\.|network-gate|profile)/.test(file)));
  const pkg=JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(),['@babel/generator','@babel/parser','@babel/traverse','@babel/types']);
  const help=spawnSync(process.execPath,['unpack.js','--help'],{cwd:project,encoding:'utf8',windowsHide:true});
  assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/2048 MiB/);
  assert.doesNotMatch(help.stdout,/--trace|--browser|--capture/);
  const obsolete=spawnSync(process.execPath,['unpack.js','--browser'],{cwd:project,encoding:'utf8',windowsHide:true});
  assert.equal(obsolete.status,1);assert.match(obsolete.stderr,/Unknown option: --browser/);
});
test('public API parses hostile operations without executing input',async()=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'pelican-offline-package-'));
  try{
    const sentinel=path.join(temporary,'input-executed.txt');
    const source=`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sentinel)},'executed');throw new Error('input ran');`;
    const result=unpack(source);assert.match(result.code,/writeFileSync/);
    await assert.rejects(fs.access(sentinel),{code:'ENOENT'});
  }finally{
    const resolved=path.resolve(temporary);
    if(path.dirname(resolved)===path.resolve(os.tmpdir())&&path.basename(resolved).startsWith('pelican-offline-package-'))await fs.rm(resolved,{recursive:true,force:true});
  }
});
test('information cards locate static accesses without simulation',()=>{
  const source="navigator.userAgent;localStorage.getItem('example');";
  const model=buildInformation(null,[{file:'src/readable.js',code:source}]);
  assert.ok(model.cards.some(card=>card.id==='info-browser'&&card.status==='code-only'));
  assert.ok(model.cards.some(card=>card.id==='info-storage'&&card.readable[0].code.includes('getItem')));
  assert.ok(model.cards.every(card=>card.evidence.length===0));
});
