#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';
import { deobfuscate } from './deobfuscate.js';
import { humanize } from './humanize.js';
import { polish } from './polish.js';
import { codeMap } from './code-map.js';
import { resolveStrings } from './strings.js';
import { nameBindings } from './namer.js';
import { buildReadingModel, readerHtml, startHere } from './reader.js';
import { advanced, diagnostics } from './advanced.js';
import { buildBehavior, behaviorMarkdown } from './behavior.js';
import { outputFiles, organizeOutput } from './output-layout.js';
import {buildInformation} from './information.js';
import {addBrief,briefMarkdown,taskExtracts} from './reading-brief.js';
import {shorten} from './shorten.js';
import {fullReadable} from './full-readable.js';
import {buildFingerprints} from './fingerprints.js';
import {shrink} from './shrink.js';
import {shortGuide} from './short-guide.js';
import {standaloneTasks} from './standalone-tasks.js';
import {MAX_HEAP_MB} from './bounded-node.js';
import {extractEmbeddedCode} from './embedded-code.js';
import {readabilityProfile,progressMarkdown} from './readability-progress.js';
import {readableFlow} from './readable-flow.js';
import {decoderWrappers} from './decoder-wrappers.js';
import {annotateFunctions,functionReading,functionIndexMarkdown} from './function-reading.js';
import {writeHumanReading} from './human-reading-output.js';
const traverse = traverseModule.default ?? traverseModule;
const generate = generatorModule.default ?? generatorModule;
const print = node => generate(node, { comments: true, jsescOption: { minimal: true } }).code + '\n';
const unknown = Symbol('unknown');

function literalValue(node, scope, seen = new Set()) {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)
    && !node.callee.computed && t.isIdentifier(node.callee.property, { name: 'concat' })) {
    const receiver = literalValue(node.callee.object, scope, seen);
    const args = node.arguments.map(argument => literalValue(argument, scope, seen));
    if (typeof receiver === 'string' && args.every(value => value !== unknown && (value === null || ['string', 'number', 'boolean'].includes(typeof value))))
      return receiver.concat(...args);
  }
  if (t.isBinaryExpression(node, { operator: '+' })) {
    const left = literalValue(node.left, scope, seen), right = literalValue(node.right, scope, seen);
    if (left !== unknown && right !== unknown && ['string', 'number'].includes(typeof left) && ['string', 'number'].includes(typeof right)) return left + right;
  }
  if (t.isSequenceExpression(node)) {
    const values = node.expressions.map(expression => literalValue(expression, scope, seen));
    if (values.every(value => value !== unknown)) return values.at(-1);
  }
  if (t.isIdentifier(node)) {
    const binding = scope.getBinding(node.name);
    if (!binding?.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return unknown;
    return literalValue(binding.path.node.init, binding.path.scope, new Set([...seen, binding]));
  }
  if (t.isObjectExpression(node)) {
    const value = Object.create(null);
    for (const prop of node.properties) {
      if (!t.isObjectProperty(prop) || prop.computed) return unknown;
      const entry = literalValue(prop.value, scope, seen);
      if (entry === unknown) return unknown;
      value[prop.key.name ?? prop.key.value] = entry;
    }
    return value;
  }
  return unknown;
}

export function unpack(source, { onStage = () => {}, deep = true, embeddedDepth=0, embeddedBudget={bytes:0,payloads:0} } = {}) {
  const timings = {};
  function stage(name, operation) {
    onStage(name);
    const started = performance.now();
    try { return operation(); }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; }
    finally { timings[name] = Math.round(performance.now() - started); }
  }
  const originalFormattedLines=stage('Measure original program',()=>print(parse(source,{sourceType:'unambiguous'})).trimEnd().split('\n').length);
  const releaseTrees=()=>{traverse.cache.clear();globalThis.gc?.();};
  releaseTrees();
  const first = stage('Parse and fold literals', () => deobfuscate(source,{passes:deep?16:8}));
  releaseTrees();
  let ast = parse(first.code, { sourceType: 'unambiguous' });
  // Serialize before dropping the old tree. Babel's paths/scopes can be larger
  // than the source; retaining two complete scoped trees exhausted the worker.
  function refold(name){
    const text=print(ast);ast=null;releaseTrees();
    const folded=stage(name,()=>deobfuscate(text));
    releaseTrees();ast=parse(folded.code,{sourceType:'unambiguous'});
    first.stats.folds+=folded.stats.folds;first.stats.properties+=folded.stats.properties;
  }
  const wrappers=stage('Unwrap constant decoder arguments',()=>decoderWrappers(ast));
  const stringTables = stage('Resolve string tables', () => resolveStrings(ast));
  stringTables.wrapperCalls=wrappers.inlinedCalls;
  if (stringTables.decodedCalls) {
    refold('Fold decoded strings');
  }
  const transforms = stage('Simplify proxies and control flow', () => advanced(ast,{passes:deep?12:6}));
  if (Object.entries(transforms).some(([key,value]) => !['passes','skipped'].includes(key) && typeof value === 'number' && value > 0)) {
    refold('Fold simplified expressions');
    const more = advanced(ast, { passes: deep?4:2 });
    for (const key of Object.keys(transforms)) if (typeof transforms[key] === 'number') transforms[key] += more[key];
  }
  const cleanup=stage('Remove unused local junk and primitive helpers',()=>shrink('',{ast,rounds:deep?12:4})).stats;
  for(let round=0;round<(deep?12:3);round++) {
    stringTables.wrapperCalls+=stage('Unwrap exposed decoder arguments',()=>decoderWrappers(ast)).inlinedCalls;
    const decoded=stage('Resolve strings exposed by simplified helpers',()=>resolveStrings(ast));
    for(const key of ['tablesFound','rotationsSolved','unrotatedTables','cachedTables','base91Tables','cachedDecodedEntries'])stringTables[key]=Math.max(stringTables[key],decoded[key]);
    stringTables.decodedCalls+=decoded.decodedCalls;stringTables.cachePreservedCalls+=decoded.cachePreservedCalls;stringTables.removedNumericLocals+=decoded.removedNumericLocals;
    if(decoded.decodedCalls)refold('Fold newly decoded strings');
    const more = stage('Simplify helpers exposed by decoded strings', () => advanced(ast,{passes:deep?12:6}));
    for (const key of Object.keys(transforms)) if (typeof transforms[key] === 'number') transforms[key] += more[key];
    const changed=Object.entries(more).some(([key,value])=>!['passes','skipped'].includes(key)&&typeof value==='number'&&value>0);
    if (!changed && !decoded.decodedCalls) break;
    refold('Fold exposed helper expressions');
    const removed=stage('Remove decoded helper aliases',()=>shrink('',{ast,rounds:deep?12:4})).stats;
    for(const key of Object.keys(cleanup))cleanup[key]+=removed[key];
  }
  function finalCleanup(){const more=stage('Clean up newly simplified code',()=>shrink('',{ast,rounds:deep?12:4})).stats;for(const key of Object.keys(cleanup))cleanup[key]+=more[key];}
  function finish(result){
    ast=null;modulePaths=[];releaseTrees();
    const embedded=embeddedDepth<2?stage('Extract embedded code without execution',()=>extractEmbeddedCode(source,
      {maxPayloads:Math.max(0,32-embeddedBudget.payloads),maxBytes:Math.max(0,1024*1024-embeddedBudget.bytes)}))
      :{stats:{candidates:0,extracted:0,unresolved:0,bytes:0},payloads:[],unresolved:[],scope:'Embedded recursion depth reached.'};
    embeddedBudget.bytes+=embedded.stats.bytes;embeddedBudget.payloads+=embedded.payloads.length;
    for(const payload of embedded.payloads){
      if(payload.syntaxError)continue;
      try{const child=unpack(payload.code,{deep,embeddedDepth:embeddedDepth+1,embeddedBudget,
        onStage:name=>onStage('Embedded payload '+payload.id+': '+name)});
        payload.readable=child.code;payload.analysis=child.stats;payload.nested=child.embedded;
      }catch(error){payload.analysisError=error.message;}
      releaseTrees();
    }
    result.embedded=embedded;result.stats.embedded={...embedded.stats,readable:embedded.payloads.filter(payload=>payload.readable).length};
    if(embeddedDepth===0){
      const before=stage('Measure input readability patterns',()=>readabilityProfile(source));releaseTrees();
      const after=stage('Measure remaining readability patterns',()=>readabilityProfile(result.code));releaseTrees();
      result.progress={before,after,scope:'Counts of syntax patterns, not a readability score or proof of execution. Short names, indexing and switches can be meaningful application logic. Remaining patterns are retained rather than guessed away.'};
    }
    return result;
  }
  const inputPatterns = diagnostics(ast);
  function generic(reason) {
    const formattedCode = print(ast);
    const readability = stage('Expand statements and infer names', () => humanize(ast, { imports: new Map(), exportMaps: new Map(), modulePaths: [], onStage }));
    readability.polish = stage('Polish readability', () => polish(ast, { modulePaths: [] }));
    const localNamer = stage('Name remaining bindings', () => nameBindings(ast));
    readability.shortening=stage('Shorten equivalent boolean and wrapper code',()=>shorten(ast));
    finalCleanup();readability.flow=stage('Expand crowded loop headers',()=>readableFlow(ast));readability.notes=stage('Explain recognized function operations',()=>annotateFunctions(ast));const code = print(ast); parse(code, { sourceType: 'unambiguous' });
    return finish({ code, formattedCode, application: code, modules: [], stats: { ...first.stats, format: 'general JavaScript',
      layoutNote: reason, originalFormattedLines, shrink:cleanup, stringTables, advanced: transforms, patterns: inputPatterns, timings, modules: 0, annotations: 0, expandedSequences: 0, readability, localNamer } });
  }
  let factories;
  let modulePaths;
  const factoryFunction = p => p.isFunctionExpression() || p.isArrowFunctionExpression();
  traverse(ast, { VariableDeclarator(p) {
    if (factories || !t.isIdentifier(p.node.id)) return;
    let entries;
    if (t.isObjectExpression(p.node.init)) {
      const props = p.get('init.properties');
      const numeric = prop => t.isNumericLiteral(prop.node.key) ? Number.isSafeInteger(prop.node.key.value) && prop.node.key.value >= 0
        : t.isStringLiteral(prop.node.key) && /^(0|[1-9]\d*)$/.test(prop.node.key.value);
      if (props.length < 2 || !props.every(prop => prop.isObjectProperty() && !prop.node.computed
        && numeric(prop) && factoryFunction(prop.get('value')))) return;
      entries = props.map(prop => ({ id: Number(prop.node.key.value), fn: prop.get('value') }));
    } else if (t.isArrayExpression(p.node.init)) {
      const elements = p.get('init.elements');
      if (!elements.every(element => !element.node || element.isNullLiteral() || factoryFunction(element))) return;
      entries = elements.flatMap((element, id) => factoryFunction(element) ? [{ id, fn: element }] : []);
      if (entries.length < 2) return;
    } else return;
    factories = p; modulePaths = entries;
  } });
  if (!factories) return generic('No supported Webpack factory table; all general transforms still ran.');
  const factoryBinding = factories.scope.getBinding(factories.node.id.name);
  let runtime;
  for (const ref of factoryBinding.referencePaths) {
    const fn = ref.getFunctionParent();
    const member = ref.parentPath;
    if (!fn?.isFunction() || fn.node.params.length !== 1 || !t.isIdentifier(fn.node.params[0]) || !member.isMemberExpression()
      || !member.node.computed || !t.isIdentifier(member.node.property, { name: fn.node.params[0].name })) continue;
    let exportsRead = false;
    fn.traverse({ MemberExpression(p) { if (!p.node.computed && t.isIdentifier(p.node.property, { name: 'exports' })) exportsRead = true; } });
    if (exportsRead && (fn.isFunctionDeclaration() || fn.parentPath.isVariableDeclarator() && t.isIdentifier(fn.parentPath.node.id))) { runtime = fn; break; }
  }
  if (!runtime) return generic('A possible factory table was found, but its loader is unsupported; the bundle wrapper was preserved.');
  const loaderName = runtime.isFunctionDeclaration() ? runtime.node.id.name : runtime.parentPath.node.id.name;
  const loaderBinding = runtime.parentPath.scope.getBinding(loaderName);
  factoryBinding.scope.rename(factoryBinding.identifier.name, factoryBinding.scope.generateUidIdentifier('moduleFactories').name);
  loaderBinding.scope.rename(loaderBinding.identifier.name, loaderBinding.scope.generateUidIdentifier('requireModule').name);
  for (const { fn } of modulePaths) {
    const names = ['module', 'exports', 'requireModule'];
    fn.node.params.forEach((param, index) => {
      if (t.isIdentifier(param) && index < names.length) fn.scope.rename(param.name, fn.scope.generateUidIdentifier(names[index]).name);
    });
  }

  const exportMaps = new Map();
  for (const { id, fn } of modulePaths) {
    const exports = Object.create(null);
    const requireParam = fn.node.params[2];
    const requireBinding = requireParam && fn.scope.getBinding(requireParam.name);
    fn.traverse({ CallExpression(p) {
      const callee = p.node.callee;
      if (!requireBinding || !t.isMemberExpression(callee) || !t.isIdentifier(callee.object)
        || p.scope.getBinding(callee.object.name) !== requireBinding
        || !t.isIdentifier(callee.property, { name: 'd' }) || !t.isObjectExpression(p.node.arguments[1])) return;
      for (const prop of p.node.arguments[1].properties) {
        if (!t.isObjectProperty(prop) || prop.computed || !t.isFunction(prop.value)) continue;
        const body = prop.value.body;
        const expr = t.isBlockStatement(body) && body.body.length === 1 && t.isReturnStatement(body.body[0])
          ? body.body[0].argument : !t.isBlockStatement(body) ? body : null;
        const value = literalValue(expr, p.scope);
        if (value !== unknown) exports[prop.key.name ?? prop.key.value] = value;
      }
    } });
    exportMaps.set(id, exports);
  }

  let annotations = 0;
  const imports = new Map();
  traverse(ast, { VariableDeclarator(p) {
    const init = p.node.init;
    if (!t.isIdentifier(p.node.id) || !t.isCallExpression(init) || !t.isIdentifier(init.callee)
      || init.arguments.length !== 1 || !t.isNumericLiteral(init.arguments[0])) return;
    const binding = p.scope.getBinding(init.callee.name);
    const factoryFn = p.getFunctionParent();
    const isModuleRequire = modulePaths.some(({ fn }) => factoryFn === fn
      && fn.node.params[2] && fn.scope.getBinding(fn.node.params[2].name) === binding);
    if (binding !== loaderBinding && !isModuleRequire) return;
    const imported = p.scope.getBinding(p.node.id.name);
    const id = init.arguments[0].value;
    imports.set(imported, id);
    // Names describe structure rather than pretending to recover source names.
    imported.scope.rename(imported.identifier.name, imported.scope.generateUidIdentifier(`module_${id}_exports`).name);
  } });
  traverse(ast, { MemberExpression(p) {
    if (!t.isIdentifier(p.node.object)) return;
    const moduleId = imports.get(p.scope.getBinding(p.node.object.name));
    const key = p.node.computed && t.isStringLiteral(p.node.property) ? p.node.property.value
      : !p.node.computed && t.isIdentifier(p.node.property) ? p.node.property.name : null;
    const map = exportMaps.get(moduleId);
    if (!map || !Object.hasOwn(map, key)) return;
    const value = JSON.stringify(map[key]);
    if (value.length > 240) return;
    t.addComment(p.node, 'trailing', ` literal export: ${value.replaceAll('*/', '* /')} `);
    annotations++;
  } });

  let sequences = 0;
  function statements(expr) {
    return t.isSequenceExpression(expr) ? expr.expressions.flatMap(statements) : [t.expressionStatement(expr)];
  }
  traverse(ast, {
    ExpressionStatement: { exit(p) {
      if (!t.isSequenceExpression(p.node.expression)) return;
      const list = statements(p.node.expression);
      t.inheritsComments(list[0], p.node);
      if (p.inList) p.replaceWithMultiple(list);
      else p.replaceWith(t.blockStatement(list));
      sequences++;
    } },
    ReturnStatement: { exit(p) {
      if (!t.isSequenceExpression(p.node.argument)) return;
      const list = p.node.argument.expressions.slice();
      const last = list.pop();
      const nodes = [...list.flatMap(statements), t.returnStatement(last)];
      t.inheritsComments(nodes[0], p.node);
      if (p.inList) p.replaceWithMultiple(nodes);
      else p.replaceWith(t.blockStatement(nodes));
      sequences++;
    } }
  });
  const formattedCode = print(ast);
  const readability = stage('Expand statements and infer names', () => humanize(ast, { imports, exportMaps, modulePaths, onStage }));
  readability.polish = stage('Polish readability', () => polish(ast, { modulePaths }));
  const localNamer = stage('Name remaining bindings', () => nameBindings(ast));
  readability.shortening=stage('Shorten equivalent boolean and wrapper code',()=>shorten(ast));
  finalCleanup();
  readability.flow=stage('Expand crowded loop headers',()=>readableFlow(ast));
  readability.notes=stage('Explain recognized function operations',()=>annotateFunctions(ast));
  let application;
  traverse(ast, { VariableDeclarator(p) {
    if (application || !t.isObjectExpression(p.node.init)) return;
    const keys = p.node.init.properties.map(prop => prop.key?.name ?? prop.key?.value);
    if (!keys.includes('setConfig') || !keys.includes('getConfig') || !keys.includes('run')) return;
    const entry = p.getFunctionParent();
    if (!entry || !t.isBlockStatement(entry.node.body)) return;
    const captured = new Set();
    entry.traverse({ ReferencedIdentifier(ref) {
      const binding = ref.scope.getBinding(ref.node.name);
      if (!binding) return;
      if (binding.path === entry || binding.path.findParent(parent => parent === entry)) return;
      captured.add(binding.identifier.name);
    } });
    const fn = t.functionDeclaration(t.identifier('clientEntry'), [...captured].map(name => t.identifier(name)), t.cloneNode(entry.node.body, true));
    application = '// Main client logic extracted for reading. Browser globals and the bundle runtime are required.\n// Parameter names identify the bindings captured from the original wrapper.\nexport default ' + print(fn);
  } });
  const modules = modulePaths.map(({ id, fn }) => {
    const dependencies = new Set();
    const param = fn.node.params[2];
    const requireBinding = param && fn.scope.getBinding(param.name);
    fn.traverse({ CallExpression(p) {
      if (requireBinding && t.isIdentifier(p.node.callee)
        && p.scope.getBinding(p.node.callee.name) === requireBinding
        && t.isNumericLiteral(p.node.arguments[0])) dependencies.add(p.node.arguments[0].value);
    } });
    return { id, dependencies: [...dependencies], literalExports: exportMaps.get(id),
      code: '// Extracted Webpack factory for inspection; requires the original bundle runtime.\nexport default ' + print(fn.node) };
  });
  const code = print(ast);
  parse(code, { sourceType: 'unambiguous' });
  return finish({ code, formattedCode, application: application ?? code, modules, stats: { ...first.stats, format: 'Webpack', stringTables,
    originalFormattedLines, shrink:cleanup, advanced: transforms, patterns: inputPatterns, timings, modules: modules.length, annotations, expandedSequences: sequences, readability, localNamer } });
}

export async function main() {
  const raw=process.argv.slice(2),maxCPU=raw.includes('--max-cpu');
  const usage='Usage: node unpack.js input.js output-directory [--max-cpu] [--debug]';
  if(raw.includes('--help')||raw.includes('-h')){
    console.log(usage+'\nOffline static deobfuscation. Input is parsed, never executed.\n--max-cpu enables bounded, RAM-aware parallel report workers. Dependent transforms use one core.\nWorker old-space heap ceiling: 2048 MiB.');return;
  }
  const unknown=raw.find(arg=>arg.startsWith('-')&&!['--max-cpu','--debug'].includes(arg));
  if(unknown)throw new Error('Unknown option: '+unknown+'\n'+usage);
  const args=raw.filter(arg=>!['--max-cpu','--debug'].includes(arg));
  const [input,destination]=args;
  if(!input||!destination||args.length!==2)throw new Error(usage);
  const source=await fs.readFile(input, 'utf8');
  const progress=name=>console.error(`[deobf] ${name}…`);
  const core=await standaloneTasks([{type:'core',data:{source}}],{maxCPU,onProgress:progress});
  const result = core.results[0];
  const generatedPaths = [...Object.keys(outputFiles),...Object.values(outputFiles),
    ...result.modules.map(module => `src/modules/${module.id}.js`)];
  const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (generatedPaths.some(file => normalized(path.join(destination,file)) === normalized(input)))
    throw new Error('The output would overwrite the input file. Choose a different output directory.');
  if(['modules','tasks','extracted-code','human-reading-data','human-reading-internals','reading-paths'].some(folder=>normalized(input).startsWith(normalized(path.join(destination,folder))+path.sep)))
    throw new Error('The output migration would move the input file. Choose a different output directory.');
  if(normalized(input).startsWith(normalized(path.join(destination,'src','tasks'))+path.sep))
    throw new Error('The output would overwrite a task extract used as input. Choose a different output directory.');
  if(normalized(input).startsWith(normalized(path.join(destination,'src','extracted-code'))+path.sep))
    throw new Error('The output would overwrite an extracted payload used as input. Choose a different output directory.');
  if(normalized(input).startsWith(normalized(path.join(destination,'src','functions'))+path.sep))
    throw new Error('The output would overwrite a function fragment used as input. Choose a different output directory.');
  if(['reading-data','reading-internals','reading-paths'].some(folder=>normalized(input).startsWith(normalized(path.join(destination,'src',folder))+path.sep)))
    throw new Error('The output would overwrite a reading artifact used as input. Choose a different output directory.');
  console.error('[deobf] Build reading view and write output…');
  await organizeOutput(destination);
  const output=name=>path.join(destination,outputFiles[name]);
  await fs.mkdir(output('modules'), { recursive: true });
  await fs.writeFile(output('readable.js'), result.code);
  console.error('[deobf] Expand complete program and verify parsed structure…');
  const full=result.full??fullReadable(result.code);
  const guide=shortGuide(full.code);
  await fs.writeFile(output('short-human-readable.js'),guide.code);
  await fs.writeFile(output('full-human-readable.js'),full.code);
  await fs.writeFile(output('formatted.js'), result.formattedCode);
  if (result.application) await fs.writeFile(output('application.js'), result.application);
  await fs.writeFile(output('CODE_MAP.md'), codeMap(result.application, result.modules));
  const reading = {};
  console.error('[deobf] Build candidate reading version and numeric path maps…');
  const {human,model:humanModel}=await writeHumanReading(destination,full.code,source);
  reading.humanReading=humanModel;
  const functions=functionReading(full.code);
  await fs.mkdir(output('functions'),{recursive:true});
  for(const item of functions.functions)await fs.writeFile(path.join(destination,item.file),item.code);
  reading.functionReading=functions;
  await fs.writeFile(output('FUNCTIONS.md'),functionIndexMarkdown(functions));
  await fs.writeFile(output('FUNCTIONS.json'),JSON.stringify({...functions,functions:functions.functions.map(({code,...item})=>item)},null,2)+'\n');
  const decodedTables=result.stats.stringTables.tables;
  await fs.writeFile(output('STRING_DECODERS.json'),JSON.stringify(decodedTables,null,2)+'\n');
  const stringReport=['# Decoded string dictionaries','','These are statically recognized decoder results. Shared caches retain their runtime first-write result; a candidate string is not proof that every call returns it. Non-ASCII Base91 candidates remain in the program.',''];
  for(const table of decodedTables){
    stringReport.push('## '+String(table.decoder??table.factory).replace(/[\r\n]/g,' '),'',`${table.entries} encoded entries; ${table.kind??table.mode??'string table'}.`,'');
    if(table.decoded?.length)stringReport.push('```json',JSON.stringify(table.decoded,null,2),'```','');
  }
  await fs.writeFile(output('STRING_DECODERS.md'),stringReport.join('\n')+'\n');
  const embeddedRows=[];
  async function saveEmbedded(embedded,prefix=''){
    for(const payload of embedded?.payloads??[]){
      const id=prefix?prefix+'-'+payload.id:String(payload.id),base='src/extracted-code/payload-'+id;
      await fs.mkdir(output('extracted-code'),{recursive:true});
      await fs.writeFile(path.join(destination,base+'.raw.txt'),payload.raw);
      if(payload.readable)await fs.writeFile(path.join(destination,base+'.readable.js'),payload.readable);
      embeddedRows.push({id,kind:payload.kind,sha256:payload.sha256,parameters:payload.parameters,sites:payload.sites,
        rawFile:base+'.raw.txt',file:base+(payload.readable?'.readable.js':'.raw.txt'),code:payload.readable??payload.raw,
        syntaxError:payload.syntaxError,analysisError:payload.analysisError??null});
      await saveEmbedded(payload.nested,id);
    }
  }
  await saveEmbedded(result.embedded);
  await fs.writeFile(output('READABILITY.md'),progressMarkdown(result.progress,result.stats));
  await fs.writeFile(output('READABILITY.json'),JSON.stringify(result.progress,null,2)+'\n');
  reading.embeddedCode={stats:result.stats.embedded,payloads:embeddedRows,unresolved:result.embedded?.unresolved??[],scope:result.embedded?.scope};
  reading.readabilityProgress=result.progress;
  await fs.writeFile(output('EMBEDDED_CODE.json'),JSON.stringify({...reading.embeddedCode,payloads:embeddedRows.map(({code,...row})=>row)},null,2)+'\n');
  await fs.writeFile(output('EMBEDDED_CODE.md'),['# Embedded code strings','',result.embedded?.scope??'',
    '',...embeddedRows.map(row=>`- ${row.kind} at line ${row.sites[0].line}: [readable payload](../${row.file}) · [original string](../${row.rawFile})`)].join('\n')+'\n');
  console.error('[deobf] Inventory fingerprint APIs and exact source lines…');
  let fingerprints,analysisWorkers=1,workerLimits=core?.resources??[];
  if(maxCPU){
    const tasks=await standaloneTasks([{type:'reading',data:{application:result.application,modules:result.modules}},{type:'fingerprints',data:{code:full.code,source}}],{maxCPU,onProgress:progress});
    Object.assign(reading,tasks.results[0]);fingerprints=tasks.results[1];analysisWorkers=tasks.workers;
    workerLimits.push(...tasks.resources);
  }else{Object.assign(reading,buildReadingModel(result.application,result.modules));reading.behavior=buildBehavior(result.application,reading);fingerprints=buildFingerprints(full.code,null,{input:source});}
  reading.information=buildInformation(null,[{file:'src/application.js',code:result.application},{file:'src/readable.js',code:result.code}]);
  reading.shortReading=guide.model;
  reading.reduction={originalLines:result.stats.originalFormattedLines,fullLines:full.stats.outputLines,...result.stats.shrink};
  reading.fingerprints=fingerprints.inventory;
  reading.fullReadable={file:'src/full-human-readable.js',...full.stats};
  await fs.writeFile(output('fingerprint-collection.js'),fingerprints.code);
  await fs.writeFile(output('fingerprints.json'),JSON.stringify(fingerprints.inventory,null,2)+'\n');
  await fs.writeFile(output('FINGERPRINTS.md'),[
    '# Fingerprint evidence', '', 'Open ../reader.html and choose Fingerprint inventory to inspect each source line.', '',
    'Complete cleaned program: ../src/full-human-readable.js',
    'Line-numbered evidence as inert JavaScript strings: ../src/fingerprint-collection.js',
    'Machine-readable inventory: fingerprints.json', '',
    '| Information or action | Code sites | Status |','| --- | ---: | --- |',
    ...fingerprints.inventory.categories.map(c=>`| ${c.title} | ${c.staticSites} | ${c.status} |`), '',
    fingerprints.inventory.scope, '', ...fingerprints.inventory.coverage.limits.map(s=>'- '+s), '',
    `Unresolved computed-property sites: ${fingerprints.inventory.unresolved.length}. They are listed in fingerprints.json.`,
    `Complete layout: ${full.stats.inputLines} → ${full.stats.outputLines} lines. Shorter layout retains the parsed structure of readable.js; original-input equivalence is not proved.`
  ].join('\n')+'\n');
  addBrief(reading);
  const extracts=taskExtracts(reading);
  await fs.mkdir(path.join(destination,'src','tasks'),{recursive:true});
  for(const extract of extracts)await fs.writeFile(path.join(destination,extract.file),extract.code);
  await fs.writeFile(output('BRIEF.md'),briefMarkdown(reading));
  await fs.writeFile(output('BEHAVIOR.md'),behaviorMarkdown(reading));
  await fs.writeFile(output('behavior.json'),JSON.stringify(reading.behavior,null,2)+'\n');
  await fs.writeFile(output('reader.html'), readerHtml(reading));
  await fs.writeFile(output('START_HERE.md'), startHere(reading));
  const patterns = result.stats.patterns;
  await fs.writeFile(output('ANALYSIS.md'), [
    '# Analysis', '', `Detected layout: ${result.stats.format}.`, ...(result.stats.layoutNote ? [result.stats.layoutNote] : []), '',
    `Decoded ${result.stats.stringTables.decodedCalls} string calls across ${result.stats.stringTables.rotationsSolved} resolved tables.`,
    `Recognized ${result.stats.stringTables.cachedTables} cached decoder tables, including ${result.stats.stringTables.base91Tables} Base91 tables. ${result.stats.stringTables.cachePreservedCalls} calls retain shared-cache behavior.`,
    `Unwrapped ${result.stats.stringTables.wrapperCalls} constant decoder forwarding calls. See STRING_DECODERS.md for decoded dictionaries and FUNCTIONS.md for reading fragments.`,
    `Inlined ${result.stats.advanced.constantReads} constant reads and ${result.stats.advanced.proxyReads} literal proxy-property reads.`,
    `Simplified ${result.stats.advanced.proxyCalls} proxy calls, ${result.stats.advanced.literalCalls} literal method/encoding calls,`,
    `${result.stats.advanced.deadBranches} constant branches, and ${result.stats.advanced.dispatchers} supported ordered dispatchers.`, '',
    `Removed ${result.stats.shrink.removedBindings} unused local bindings, ${result.stats.shrink.removedFunctions} unused local functions, ${result.stats.shrink.removedStatements} harmless statements and ${result.stats.shrink.removedUnreachable} unreachable statements.`,
    `Folded ${result.stats.shrink.foldedHelperCalls} eligible primitive helper calls. Original formatted program: ${result.stats.originalFormattedLines} lines; complete cleaned program: ${full.stats.outputLines} lines.`,
    `Short reading guide: ${guide.model.lines} lines indexing ${guide.model.sites.length} recognized calls; it cannot replace the complete program.`, '',
    `Remaining switches: ${patterns.switches}; recognized compiled async state machines: ${patterns.asyncStateMachines}.`,
    `Other possible ordered dispatchers: ${patterns.possibleDispatchers}. Dynamic code construction sites: ${patterns.dynamicCodeSites}.`, '',
    'Compiled async state machines are kept intact and split into reading stages. They are not assumed to be obfuscation.',
    'Unsupported dispatchers, dynamic function construction, and custom VM code are retained. The static transforms never execute input.',
    'Input was parsed statically and was not executed.',
    'Names and summaries are inferred. Browser integration and reflection-sensitive behavior need application-specific validation.'
  ].join('\n') + '\n');
  for (const module of result.modules) await fs.writeFile(path.join(output('modules'), `${module.id}.js`), module.code);
  const report = { stats: result.stats, reading: { sections: reading.cards.length, applicationLines: reading.totalLines, tasks:reading.behavior.journeys.length,accessGroups:reading.behavior.features.length,
    informationGroups:reading.information.cards.length,observedInformationGroups:reading.information.cards.filter(c=>c.status==='observed').length,
    taskExtractLines:reading.taskReading.lines },
    reduction:reading.reduction,readabilityProgress:result.progress,embeddedCode:{...result.stats.embedded,payloadFiles:embeddedRows.map(({code,...row})=>row)},shortReading:{lines:guide.model.lines,operations:guide.model.sites.length,limit:guide.model.limit},performance:{maxCPU,analysisWorkers,maximumHeapMb:MAX_HEAP_MB,...(maxCPU?{heapMbPerWorker:Math.max(...workerLimits.map(job=>job.heapMb)),workerLimits}:{} )},fullReadable:full.stats,fingerprints:{recognizedSites:fingerprints.inventory.findings.length,observedEvents:fingerprints.inventory.observations.length,unresolvedComputedSites:fingerprints.inventory.unresolved.length},
    humanReading:human.stats,dispatchers:{machines:human.dispatchers.machines.length,states:human.dispatchers.machines.reduce((n,m)=>n+m.nodes.length,0),structuredPaths:human.dispatchers.machines.filter(m=>m.pathCode).length},
    functionReading:{functions:functions.functions.length,totalCandidates:functions.totalCandidates,bytes:functions.bytes},
    modules: result.modules.map(({ code, ...rest }) => rest) };
  await fs.writeFile(output('report.json'), JSON.stringify(report, null, 2) + '\n');
  const { renames, polish: polishing, ...readability } = result.stats.readability;
  const { renames: polishedNames, ...polishStats } = polishing;
  const { localNamer, ...stats } = result.stats;
  console.log(JSON.stringify({ ...stats, localNamer: { engine: localNamer.engine, renamedBindings: localNamer.renames.length, skipped: localNamer.skipped }, reading: report.reading, readability: { ...readability, renamedBindings: renames.length, polish: { ...polishStats, renamedBindings: polishedNames.length } } }, null, 2));
  console.log(`Open ${path.resolve(destination, 'reader.html')} to read one section at a time.`);
  console.log(`Original formatted program: ${result.stats.originalFormattedLines} lines; complete cleaned program: ${full.stats.outputLines} lines; short guide: ${guide.model.lines} lines (${guide.model.sites.length} recognized operations).`);
  if(maxCPU)console.log(`Deeper static passes enabled. Independent reports used ${analysisWorkers} worker(s) within the RAM budget. Dependent transforms use one CPU core.`);
  console.log(`Complete source: ${full.stats.outputLines} lines. Fingerprint evidence: ${fingerprints.inventory.findings.length} code sites.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(process.argv.includes('--debug') ? error.stack : `${error.message}\nUse --debug for the stack trace.`); process.exitCode = 1; });
}
