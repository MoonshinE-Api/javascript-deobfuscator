import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {staticSafety} from './static-safety.js';
import {dynamicBindings} from './dynamic-scope.js';
import {resolveCachedStrings} from './cached-strings.js';
const traverse = traverseModule.default ?? traverseModule;
const UNKNOWN = Symbol('unknown');
const marker = (kind, table) => ({ kind, table });
const unconditional=p=>p.parentPath.isProgram()||p.parentPath.isBlockStatement()&&p.parentPath.parentPath.isFunction()&&p.parentPath.key==='body';
function decoderOnlyCalls(binding,owner,seen=new Set()){
  if(!binding||seen.has(binding))return false;seen=new Set([...seen,binding]);
  return binding.referencePaths.every(ref=>{
    if(ref.findParent(p=>p===owner))return true;
    const parent=ref.parentPath;
    if(parent.isCallExpression()&&parent.node.callee===ref.node)return true;
    if(parent.isVariableDeclarator()&&parent.node.init===ref.node&&t.isIdentifier(parent.node.id)){
      const alias=parent.scope.getBinding(parent.node.id.name);return alias?.constant&&decoderOnlyCalls(alias,owner,seen);
    }
    return false;
  });
}

// A small arithmetic interpreter used only for string-table checksums.
// It never invokes input functions, eval, a VM, or a browser.
function read(node, scope, locals, tables, seen = new Set(), depth = 0) {
  if (!node || depth > 80) return UNKNOWN;
  const child = n => read(n, scope, locals, tables, seen, depth + 1);
  if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isIdentifier(node)) {
    if (locals.has(node.name)) return locals.get(node.name);
    const binding = scope.getBinding(node.name);
    if (tables.has(binding)) return tables.get(binding);
    if (!binding?.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return UNKNOWN;
    if (node.start != null && binding.path.node.end != null && binding.path.node.end > node.start) return UNKNOWN;
    return read(binding.path.node.init, binding.path.scope, new Map(), tables, new Set([...seen, binding]), depth + 1);
  }
  if (t.isSequenceExpression(node)) {
    // Only the final identifier is needed for an alias; preceding side effects
    // stay in the input AST and are never executed by this interpreter.
    const last = child(node.expressions.at(-1));
    if (last?.kind === 'factory' || last?.kind === 'decoder') return last;
    return node.expressions.every(expression => child(expression) !== UNKNOWN) ? last : UNKNOWN;
  }
  if (t.isUnaryExpression(node)) {
    const value = child(node.argument);
    if (!['number', 'string', 'boolean'].includes(typeof value)) return UNKNOWN;
    if (node.operator === '-') return -value;
    if (node.operator === '+') return +value;
    if (node.operator === '!') return !value;
    return UNKNOWN;
  }
  if (t.isBinaryExpression(node)) {
    const a = child(node.left), b = child(node.right);
    if (!['number', 'string', 'boolean'].includes(typeof a) || !['number', 'string', 'boolean'].includes(typeof b)) return UNKNOWN;
    switch (node.operator) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return a / b;
      case '%': return a % b;
      case '===': return a === b;
      case '==': return a == b;
      default: return UNKNOWN;
    }
  }
  if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
    if (node.callee.name === 'parseInt' && !scope.getBinding('parseInt') && !locals.has('parseInt')) {
      if (node.arguments.length < 1 || node.arguments.length > 2) return UNKNOWN;
      const value = child(node.arguments[0]), radix = node.arguments[1] ? child(node.arguments[1]) : undefined;
      return typeof value === 'string' && (radix === undefined || typeof radix === 'number') ? Number.parseInt(value, radix) : UNKNOWN;
    }
    const callee = child(node.callee);
    if (callee?.kind === 'factory' && node.arguments.length === 0) return marker('array', callee.table);
    if (callee?.kind === 'decoder' && node.arguments.length >= 1 && node.arguments.length <= 2) {
      const index = child(node.arguments[0]);
      if (!Number.isInteger(index)) return UNKNOWN;
      const position = index - callee.table.offset, table = callee.table;
      if (position < 0 || position >= table.values.length) return UNKNOWN;
      // Candidate rotations are views of the original table, not N copies
      // of an N-element array. The final accepted rotation is materialized.
      return table.candidateRotation == null ? table.current[position]
        : table.values[(position + table.candidateRotation) % table.values.length];
    }
  }
  return UNKNOWN;
}

function factoryTable(p) {
  const fn = p.node;
  if (fn.params.length || ![2, 3].includes(fn.body.body.length) || !t.isVariableDeclaration(fn.body.body[0])) return null;
  const declaration = fn.body.body[0].declarations;
  if (declaration.length !== 1 || !t.isIdentifier(declaration[0].id) || !t.isArrayExpression(declaration[0].init)
    || !declaration[0].init.elements.length || !declaration[0].init.elements.every(value => t.isStringLiteral(value))) return null;
  const ret = fn.body.body.at(-1);
  const assignment = fn.body.body.length === 3 && t.isExpressionStatement(fn.body.body[1])
    ? fn.body.body[1].expression : ret.argument?.callee;
  if (!t.isReturnStatement(ret) || !t.isCallExpression(ret.argument) || ret.argument.arguments.length
    || !t.isAssignmentExpression(assignment, { operator: '=' })
    || !t.isIdentifier(assignment.left, { name: fn.id.name }) || !t.isFunctionExpression(assignment.right)
    || fn.body.body.length === 3 && !t.isIdentifier(ret.argument.callee, { name: fn.id.name })) return null;
  const inner = assignment.right;
  if (inner.params.length || inner.body.body.length !== 1 || !t.isReturnStatement(inner.body.body[0])
    || !t.isIdentifier(inner.body.body[0].argument, { name: declaration[0].id.name })) return null;
  const binding = p.parentPath.scope.getBinding(fn.id.name);
  // The only write must be the recognized self-memoization assignment.
  if (binding.constantViolations.some(violation => violation.node !== assignment)) return null;
  const values = declaration[0].init.elements.map(element => element.value);
  return { binding, path: p, values, current: values.slice(), offset: null, rotation: null };
}

function decoderTable(p, factories) {
  const fn = p.node;
  if (!fn.params.every(param => t.isIdentifier(param)) || fn.params.length < 1 || fn.params.length > 2
    || ![2, 3].includes(fn.body.body.length) || !t.isVariableDeclaration(fn.body.body[0])) return null;
  const vars = fn.body.body[0].declarations;
  if (vars.length !== 1 || !t.isIdentifier(vars[0].id) || !t.isCallExpression(vars[0].init)
    || !t.isIdentifier(vars[0].init.callee) || vars[0].init.arguments.length) return null;
  const table = factories.get(p.scope.getBinding(vars[0].init.callee.name));
  if (!table) return null;
  const ret = fn.body.body.at(-1);
  if (!t.isReturnStatement(ret)) return null;
  const sequence = t.isSequenceExpression(ret.argument) && ret.argument.expressions.length === 2 ? ret.argument.expressions : null;
  const call = sequence ? sequence[1] : ret.argument;
  if (!t.isCallExpression(call)) return null;
  const assignment = sequence ? sequence[0] : fn.body.body.length === 2 ? call.callee
    : t.isExpressionStatement(fn.body.body[1]) ? fn.body.body[1].expression : null;
  if (!t.isAssignmentExpression(assignment, { operator: '=' }) || !t.isIdentifier(assignment.left, { name: fn.id.name })
    || !t.isFunctionExpression(assignment.right) || ((sequence || fn.body.body.length === 3) && !t.isIdentifier(call.callee, { name: fn.id.name }))) return null;
  const inner = assignment.right;
  let member, offset;
  if (inner.body.body.length === 1 && t.isReturnStatement(inner.body.body[0])) {
    member = inner.body.body[0].argument;
    if (!t.isMemberExpression(member) || !t.isAssignmentExpression(member.property, { operator: '-=' })
      || !t.isIdentifier(member.property.left, { name: inner.params[0]?.name }) || !t.isNumericLiteral(member.property.right)) return null;
    offset = member.property.right.value;
  } else {
    // Readable formatting expands `return a[i-=offset]` into a subtraction,
    // a temporary table read, and a return. Recognize only that exact shape.
    const statements = inner.body.body;
    if (![2, 3].includes(statements.length) || !t.isExpressionStatement(statements[0])) return null;
    const subtract = statements[0].expression;
    if (!t.isAssignmentExpression(subtract, { operator: '=' })
      || !t.isIdentifier(subtract.left, { name: inner.params[0]?.name })
      || !t.isBinaryExpression(subtract.right, { operator: '-' })
      || !t.isIdentifier(subtract.right.left, { name: inner.params[0]?.name }) || !t.isNumericLiteral(subtract.right.right)) return null;
    offset = subtract.right.right.value;
    const last = statements.at(-1);
    if (!t.isReturnStatement(last)) return null;
    if (statements.length === 2) member = last.argument;
    else {
      const declaration = statements[1];
      if (!t.isVariableDeclaration(declaration) || declaration.declarations.length !== 1) return null;
      const temp = declaration.declarations[0];
      if (!t.isIdentifier(temp.id) || !t.isIdentifier(last.argument, { name: temp.id.name })) return null;
      member = temp.init;
    }
    if (!t.isMemberExpression(member) || !t.isIdentifier(member.property, { name: inner.params[0]?.name })) return null;
  }
  if (!member.computed || !t.isIdentifier(member.object, { name: vars[0].id.name })
    || !inner.params.every(param => t.isIdentifier(param)) || inner.params.length < 1 || inner.params.length > 2
    || new Set(inner.params.map(param => param.name)).size !== inner.params.length
    || call.arguments.length !== fn.params.length
    || call.arguments.some((arg, index) => !t.isIdentifier(arg, { name: fn.params[index].name }))) return null;
  const binding = p.parentPath.scope.getBinding(fn.id.name);
  if (binding.constantViolations.some(violation => violation.node !== assignment)) return null;
  table.offset = offset;
  table.decoderPath = p;
  table.decoderBinding = binding;
  return table;
}

function shiftStatement(statement, variable) {
  const call = t.isExpressionStatement(statement) && statement.expression;
  return t.isCallExpression(call) && t.isMemberExpression(call.callee) && !call.callee.computed
    && t.isIdentifier(call.callee.object, { name: variable }) && t.isIdentifier(call.callee.property, { name: 'push' })
    && call.arguments.length === 1 && t.isCallExpression(call.arguments[0])
    && t.isMemberExpression(call.arguments[0].callee) && !call.arguments[0].callee.computed
    && t.isIdentifier(call.arguments[0].callee.object, { name: variable })
    && t.isIdentifier(call.arguments[0].callee.property, { name: 'shift' }) && !call.arguments[0].arguments.length;
}

function expandedRotation(p, table, markers) {
  const fn = p.node.callee, statements = fn.body.body, loop = statements.at(-1);
  if (fn.async || fn.generator || ![1, 2].includes(fn.params.length)
    || !fn.params.every(param => t.isIdentifier(param)) || fn.body.directives.length
    || !statements.slice(0, -1).every(statement => t.isVariableDeclaration(statement))) return false;
  const trueLoop = node => t.isBooleanLiteral(node, { value: true })
    || t.isUnaryExpression(node, { operator: '!' }) && t.isUnaryExpression(node.argument, { operator: '!' })
    && t.isArrayExpression(node.argument.argument) && !node.argument.argument.elements.length;
  if (!t.isWhileStatement(loop) || !trueLoop(loop.test) || !t.isBlockStatement(loop.body)
    || loop.body.body.length !== 1 || !t.isTryStatement(loop.body.body[0])) return false;
  const attempt = loop.body.body[0];
  if (attempt.finalizer || !attempt.handler || attempt.handler.body.body.length !== 1) return false;
  const condition = attempt.block.body.at(-1), checksumDeclarations = attempt.block.body.slice(0, -1);
  const single = node => t.isBlockStatement(node) && node.body.length === 1 ? node.body[0] : node;
  if (!t.isIfStatement(condition) || !t.isBreakStatement(single(condition.consequent))
    || single(condition.consequent).label || !checksumDeclarations.every(statement => t.isVariableDeclaration(statement))
    || !t.isBinaryExpression(condition.test) || !['==', '==='].includes(condition.test.operator)) return false;
  const loopPath = p.get(`callee.body.body.${statements.length - 1}`), locals = new Map();
  locals.set(fn.params[0].name, marker('factory', table));
  if (fn.params[1]) locals.set(fn.params[1].name, read(p.node.arguments[1], p.scope, new Map(), markers));
  let arrayVariable;
  for (const statement of statements.slice(0, -1)) for (const declaration of statement.declarations) {
    if (!t.isIdentifier(declaration.id) || locals.has(declaration.id.name)) return false;
    const value = read(declaration.init, loopPath.scope, locals, markers);
    if (value === UNKNOWN) return false;
    locals.set(declaration.id.name, value);
    if (value?.kind === 'array' && value.table === table) arrayVariable = declaration.id.name;
  }
  if (!arrayVariable || !shiftStatement(single(condition.alternate), arrayVariable)
    || !shiftStatement(attempt.handler.body.body[0], arrayVariable)) return false;
  const matches = [];
  for (let rotation = 0; rotation < table.values.length; rotation++) {
    table.candidateRotation = rotation;
    const scratch = new Map(locals);
    for (const statement of checksumDeclarations) for (const declaration of statement.declarations) {
      if (!t.isIdentifier(declaration.id) || scratch.has(declaration.id.name)) return false;
      const value = read(declaration.init, loopPath.scope, scratch, markers);
      if (value === UNKNOWN) return false;
      scratch.set(declaration.id.name, value);
    }
    const value = read(condition.test, loopPath.scope, scratch, markers);
    if (value === UNKNOWN) return false;
    if (value === true) matches.push(rotation);
  }
  delete table.candidateRotation;
  if (matches.length !== 1) return false;
  table.rotation = matches[0];
  table.current = table.values.slice(table.rotation).concat(table.values.slice(0, table.rotation));
  table.rotationPath = p;
  return true;
}

function solveRotation(p, table, markers) {
  const fn = p.node.callee;
  if (fn.async || fn.generator || fn.params.length < 1 || fn.params.length > 2
    || !fn.params.every(param => t.isIdentifier(param)) || fn.body.body.length !== 1) return false;
  const loop = fn.body.body[0];
  if (!t.isForStatement(loop) || loop.test || loop.update || !t.isVariableDeclaration(loop.init)) return false;
  const body = t.isBlockStatement(loop.body) && loop.body.body.length === 1 ? loop.body.body[0] : loop.body;
  if (!t.isTryStatement(body) || body.finalizer || !body.handler || body.block.body.length !== 2) return false;
  const condition = body.block.body[0];
  if (!t.isIfStatement(condition) || condition.alternate || !t.isBreakStatement(condition.consequent)
    || condition.consequent.label || !t.isBinaryExpression(condition.test) || !['==', '==='].includes(condition.test.operator)) return false;
  const locals = new Map([[fn.params[0].name, marker('factory', table)]]);
  if (fn.params[1]) locals.set(fn.params[1].name, p.node.arguments[1] ? read(p.node.arguments[1], p.scope, new Map(), markers) : UNKNOWN);
  let arrayVariable;
  const loopPath = p.get('callee.body.body.0');
  for (const declaration of loop.init.declarations) {
    if (!t.isIdentifier(declaration.id)) return false;
    const value = read(declaration.init, loopPath.scope, locals, markers);
    if (value === UNKNOWN) return false;
    locals.set(declaration.id.name, value);
    if (value?.kind === 'array' && value.table === table) arrayVariable = declaration.id.name;
  }
  if (!arrayVariable || !shiftStatement(body.block.body[1], arrayVariable)
    || body.handler.body.body.length !== 1 || !shiftStatement(body.handler.body.body[0], arrayVariable)) return false;
  const matches = [];
  for (let rotation = 0; rotation < table.values.length; rotation++) {
    table.candidateRotation = rotation;
    const value = read(condition.test, loopPath.scope, locals, markers);
    if (value === UNKNOWN) return false;
    if (value === true) matches.push(rotation);
  }
  delete table.candidateRotation;
  if (matches.length !== 1) return false;
  table.rotation = matches[0];
  table.current = table.values.slice(table.rotation).concat(table.values.slice(0, table.rotation));
  table.rotationPath = p;
  return true;
}

export function resolveStrings(ast) {
  const cached=resolveCachedStrings(ast);
  const stats = { tablesFound: cached.cachedTables, rotationsSolved: 0, unrotatedTables:0, cachedTables:cached.cachedTables,base91Tables:cached.base91Tables,cachedDecodedEntries:cached.cachedDecodedEntries,cachePreservedCalls:cached.cachePreservedCalls, decodedCalls: cached.decodedCalls, removedNumericLocals: 0, tables: [...cached.tables] };
  const factories = new Map(), markers = new Map();
  let dynamic = false;
  traverse(ast, { CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' })) dynamic = true; } });
  if (dynamic) return { ...stats, skipped: 'Direct eval or with prevents reliable string-table resolution.' };
  const unsafe=dynamicBindings(ast);
  traverse(ast, { WithStatement(p){p.skip();},FunctionDeclaration(p) {
    const table = factoryTable(p);
    if (table&&!unsafe.has(table.binding)) factories.set(table.binding, table);
  } });
  for (const [binding, table] of factories) markers.set(binding, marker('factory', table));
  traverse(ast, { FunctionDeclaration(p) {
    const table = decoderTable(p, factories);
    if (table) markers.set(table.decoderBinding, marker('decoder', table));
  } });
  stats.tablesFound += [...factories.values()].filter(table => table.decoderBinding).length;
  traverse(ast, { CallExpression(p) {
    if (!t.isFunctionExpression(p.node.callee) || p.node.arguments.length < 1 || p.node.arguments.length > 2
      || !t.isIdentifier(p.node.arguments[0])) return;
    const table = factories.get(p.scope.getBinding(p.node.arguments[0].name));
    if (!table?.decoderBinding || table.rotation !== null) return;
    let resolved;
    try {resolved=solveRotation(p,table,markers);} finally {delete table.candidateRotation;}
    if(!resolved)try {resolved=expandedRotation(p,table,markers);} finally {delete table.candidateRotation;}
    if (resolved) {
      stats.rotationsSolved++;
      stats.tables.push({ factory: table.binding.identifier.name, decoder: table.decoderBinding.identifier.name,
        entries: table.values.length, offset: table.offset, rotation: table.rotation });
      t.addComment(p.node, 'leading', ` Resolved string table (${table.values.length} entries, rotation ${table.rotation}); initialization retained. `);
    }
  } });
  const safety=staticSafety(ast);
  if(!safety.intrinsicsChanged)for(const table of factories.values()){
    if(!table.decoderBinding||table.rotation!==null||!unconditional(table.path)||!unconditional(table.decoderPath)
      ||safety.globalWrites&&table.binding.scope.path.isProgram())continue;
    const closed=table.binding.referencePaths.every(ref=>ref.findParent(p=>p===table.path||p===table.decoderPath));
    if(!closed||!decoderOnlyCalls(table.decoderBinding,table.decoderPath))continue;
    table.rotation=0;table.current=table.values.slice();table.rotationPath=null;stats.unrotatedTables++;
    stats.tables.push({factory:table.binding.identifier.name,decoder:table.decoderBinding.identifier.name,entries:table.values.length,offset:table.offset,rotation:0,mode:'unrotated'});
  }
  const solved = [...factories.values()].filter(table => table.rotation !== null);
  if (!solved.length) return stats;
  for (const table of solved) {
    const escaping = table.binding.referencePaths.some(ref => !ref.findParent(parent => parent === table.path
      || parent === table.decoderPath || parent === table.rotationPath));
    if (escaping) table.rotation = null;
  }
  traverse(ast, { CallExpression: { exit(p) {
    if (!t.isIdentifier(p.node.callee)) return;
    const callee = read(p.node.callee, p.scope, new Map(), markers);
    if (callee?.kind !== 'decoder' || callee.table.rotation === null) return;
    const table = callee.table;
    if (table.rotationPath&&p.node.start <= table.rotationPath.node.end
      || p.findParent(parent => parent === table.rotationPath || parent === table.decoderPath || parent === table.path)) return;
    // Extra arguments are allowed only if they are literal/constant primitives;
    // their evaluation must not hide input side effects.
    if (p.node.arguments.length < 1 || p.node.arguments.length > 2) return;
    const values = p.node.arguments.map(argument => read(argument, p.scope, new Map(), markers));
    if (!values.every(value => ['number', 'string', 'boolean'].includes(typeof value))) return;
    const index = values[0] - table.offset;
    if (!Number.isInteger(index) || index < 0 || index >= table.current.length) return;
    p.replaceWith(t.stringLiteral(table.current[index]));
    stats.decodedCalls++;
  } } });
  traverse(ast, { Program(p) { p.scope.crawl(); p.stop(); } });
  // Remove only now-unused numeric scratch declarations, never calls or
  // assignment expressions that could carry runtime side effects.
  traverse(ast, { VariableDeclarator(p) {
    if (!t.isIdentifier(p.node.id) || !t.isNumericLiteral(p.node.init)) return;
    const binding = p.scope.getBinding(p.node.id.name);
    if (!binding || binding.referenced || !binding.constant || !p.parentPath.parentPath.isBlockStatement()) return;
    p.remove();
    stats.removedNumericLocals++;
  } });
  return stats;
}
