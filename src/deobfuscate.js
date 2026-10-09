#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import generatorModule from '@babel/generator';
import * as t from '@babel/types';

const traverse = traverseModule.default ?? traverseModule;
const generate = generatorModule.default ?? generatorModule;
const UNKNOWN = Symbol('unknown');
const primitive = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const MAX_STRING = 1_000_000;

function isWriteTarget(p) {
  let current = p;
  while (current.parentPath) {
    const parent = current.parentPath;
    if (parent.isAssignmentExpression()) return parent.node.left === current.node;
    if (parent.isUpdateExpression() || parent.isUnaryExpression({ operator: 'delete' })) return true;
    if (parent.isForInStatement() || parent.isForOfStatement()) return parent.node.left === current.node;
    if (parent.isArrayPattern() || parent.isObjectPattern() || parent.isObjectProperty()
      || parent.isRestElement() || parent.isAssignmentPattern()) current = parent;
    else return false;
  }
  return false;
}

// This is a deliberately limited interpreter for literal expressions, not eval.
function evaluate(node, locals = new Map(), depth = 0) {
  if (!node || depth > 80) return UNKNOWN;
  const read = child => evaluate(child, locals, depth + 1);
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isIdentifier(node)) return locals.has(node.name) ? locals.get(node.name) : UNKNOWN;
  if (t.isArrayExpression(node)) {
    if (node.elements.length > 10000) return UNKNOWN;
    const values = node.elements.map(read);
    return values.every(primitive) ? values : UNKNOWN;
  }
  if (t.isUnaryExpression(node)) {
    const value = read(node.argument);
    if (value === UNKNOWN || !primitive(value)) return UNKNOWN;
    switch (node.operator) {
      case '!': return !value;
      case '+': return +value;
      case '-': return -value;
      case '~': return ~value;
      case 'typeof': return typeof value;
      default: return UNKNOWN;
    }
  }
  if (t.isConditionalExpression(node)) {
    const test = read(node.test);
    return test !== UNKNOWN && primitive(test) ? read(test ? node.consequent : node.alternate) : UNKNOWN;
  }
  if (t.isLogicalExpression(node)) {
    const left = read(node.left);
    if (left === UNKNOWN || !primitive(left)) return UNKNOWN;
    if (node.operator === '&&') return left ? read(node.right) : left;
    if (node.operator === '||') return left ? left : read(node.right);
    if (node.operator === '??') return left === null ? read(node.right) : left;
  }
  if (t.isBinaryExpression(node)) {
    const a = read(node.left), b = read(node.right);
    if (!primitive(a) || !primitive(b)) return UNKNOWN;
    switch (node.operator) {
      case '+': return typeof a === 'string' || typeof b === 'string'
        ? (String(a).length + String(b).length <= MAX_STRING ? a + b : UNKNOWN) : a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return a / b;
      case '%': return a % b;
      case '**': return a ** b;
      case '<<': return a << b;
      case '>>': return a >> b;
      case '>>>': return a >>> b;
      case '|': return a | b;
      case '&': return a & b;
      case '^': return a ^ b;
      case '==': return a == b;
      case '!=': return a != b;
      case '===': return a === b;
      case '!==': return a !== b;
      case '<': return a < b;
      case '<=': return a <= b;
      case '>': return a > b;
      case '>=': return a >= b;
      default: return UNKNOWN;
    }
  }
  if (t.isMemberExpression(node) && !node.optional) {
    const object = read(node.object);
    const key = node.computed ? read(node.property) : node.property.name;
    if (typeof object !== 'string' && !Array.isArray(object)) return UNKNOWN;
    if (key === 'length') return object.length;
    const index = typeof key === 'number' ? key : typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : -1;
    return Number.isInteger(index) && index >= 0 && index < object.length ? object[index] : UNKNOWN;
  }
  return UNKNOWN;
}

function replaceValue(p, value, stats) {
  if (!primitive(value) || (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))) return;
  const replacement = t.valueToNode(value);
  if (t.isNodesEquivalent(p.node, replacement)) return;
  p.replaceWith(replacement);
  stats.folds++;
}

// Only tables whose references are direct reads qualify. Escapes, writes,
// method calls and aliases disqualify a table because its contents may change.
function tableForBinding(binding) {
  if (!binding?.constant || !binding.path.isVariableDeclarator()) return null;
  const container = binding.path.parentPath.parentPath;
  if (!container.isProgram() && !(container.isBlockStatement()
    && container.parentPath.isFunction() && container.key === 'body')) return null;
  const values = evaluate(binding.path.node.init);
  if (!Array.isArray(values)) return null;
  for (const ref of binding.referencePaths) {
    const member = ref.parentPath;
    if (!member.isMemberExpression() || member.node.object !== ref.node || !member.node.computed) return null;
    const parent = member.parentPath;
    if (isWriteTarget(member)
      || (parent.isCallExpression() && parent.node.callee === member.node)
      || parent.isNewExpression() || parent.isTaggedTemplateExpression()
      || parent.isForInStatement() || parent.isForOfStatement()) return null;
  }
  return values;
}

function decoderForBinding(binding, getTable = tableForBinding) {
  if (!binding?.constant) return null;
  let fn = binding.path.node;
  if (t.isVariableDeclarator(fn)) fn = fn.init;
  if (!(t.isFunctionDeclaration(fn) || t.isFunctionExpression(fn) || t.isArrowFunctionExpression(fn))
    || fn.async || fn.generator || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return null;
  let expression = fn.body;
  if (t.isBlockStatement(expression)) {
    if (expression.body.length !== 1 || !t.isReturnStatement(expression.body[0])) return null;
    expression = expression.body[0].argument;
  }
  if (!t.isMemberExpression(expression) || !expression.computed || !t.isIdentifier(expression.object)) return null;
  const fnPath = binding.path.isVariableDeclarator() ? binding.path.get('init') : binding.path;
  const tableBinding = fnPath.scope.getBinding(expression.object.name);
  const table = getTable(tableBinding);
  if (!table) return null;
  return { parameter: fn.params[0].name, index: expression.property, table, tableBinding };
}

export function deobfuscate(source, { passes = 8 } = {}) {
  if (!Number.isInteger(passes) || passes < 1 || passes > 30) throw new Error('passes must be between 1 and 30');
  const ast = parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });
  const stats = { folds: 0, properties: 0, branches: 0, passes: 0 };
  // Direct eval and with can mutate bindings invisible to static analysis.
  let dynamicScope = false;
  traverse(ast, {
    WithStatement() { dynamicScope = true; },
    CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' })) dynamicScope = true; }
  });
  for (let pass = 0; pass < passes; pass++) {
    const before = stats.folds + stats.properties + stats.branches;
    // Validate each binding once per pass, including rejected candidates.
    // Scanning every reference for every lookup made tables quadratic.
    const tables = new WeakMap(), decoders = new WeakMap();
    const cached = (cache, binding, read) => {
      if (!binding) return null;
      if (!cache.has(binding)) cache.set(binding, read(binding));
      return cache.get(binding);
    };
    const getTable = binding => cached(tables, binding, tableForBinding);
    traverse(ast, {
      Expression: { exit(p) {
        if (p.isMemberExpression() && p.node.computed && t.isStringLiteral(p.node.property) && t.isValidIdentifier(p.node.property.value)) {
          p.node.property = t.identifier(p.node.property.value);
          p.node.computed = false;
          stats.properties++;
        }
        // Rewriting assignment targets would produce invalid code.
        if (!p.isReferenced() && (p.isIdentifier() || p.isMemberExpression())) return;
        if (p.isMemberExpression()) {
          const parent = p.parentPath;
          if (isWriteTarget(p)) return;
          if (!dynamicScope && t.isIdentifier(p.node.object) && p.node.computed) {
            const binding = p.scope.getBinding(p.node.object.name);
            const table = getTable(binding);
            // var reads before initialization and cross-function reads stay intact.
            if (table && binding.path.node.end < p.node.start
              && binding.path.getFunctionParent() === p.getFunctionParent()) {
              replaceValue(p, evaluate(p.node, new Map([[p.node.object.name, table]])), stats);
              if (!p.isMemberExpression()) return;
            }
          }
          if (p.node.computed && t.isStringLiteral(p.node.property) && t.isValidIdentifier(p.node.property.value)) {
            p.node.property = t.identifier(p.node.property.value);
            p.node.computed = false;
            stats.properties++;
          }
        }
        if (!dynamicScope && p.isCallExpression() && t.isIdentifier(p.node.callee) && p.node.arguments.length === 1) {
          const binding = p.scope.getBinding(p.node.callee.name);
          const decoder = cached(decoders, binding, value => decoderForBinding(value, getTable));
          if (decoder && binding.path.node.end < p.node.start
            && decoder.tableBinding.path.node.end < p.node.start
            && decoder.tableBinding.path.getFunctionParent() === p.getFunctionParent()
            && binding.path.getFunctionParent() === p.getFunctionParent()) {
            const arg = evaluate(p.node.arguments[0]);
            if (primitive(arg)) {
              const index = evaluate(decoder.index, new Map([[decoder.parameter, arg]]));
              if (Number.isInteger(index) && index >= 0 && index < decoder.table.length) {
                replaceValue(p, decoder.table[index], stats);
                return;
              }
            }
          }
        }
        if (p.isLiteral()) {
          if (p.node.extra) delete p.node.extra; // hexadecimal and escaped spellings
          return;
        }
        replaceValue(p, evaluate(p.node), stats);
      } }
    });
    stats.passes++;
    if (before === stats.folds + stats.properties + stats.branches) break;
  }
  return { code: generate(ast, { comments: true, jsescOption: { minimal: true } }).code + '\n', stats };
}

export async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node deobfuscate.js <input.js|-> [-o output.js] [--passes 1..30]\nUse - for stdin. Without -o, readable JavaScript goes to stdout.\nInput is parsed and transformed statically; it is never executed.');
    return;
  }
  const input = args.shift();
  let output, passes = 8;
  while (args.length) {
    const flag = args.shift();
    if (flag === '-o' || flag === '--output') {
      output = args.shift();
      if (!output) throw new Error('Missing output path');
    } else if (flag === '--passes') passes = Number(args.shift());
    else throw new Error(`Unknown option: ${flag}`);
  }
  let source;
  if (input === '-') {
    process.stdin.setEncoding('utf8');
    source = '';
    for await (const chunk of process.stdin) source += chunk;
  } else source = await fs.readFile(input, 'utf8');
  // The installed CLI uses the same quality pipeline as unpack.js. Keep the
  // small exported folding primitive available for the pipeline's refolds.
  const folded = deobfuscate(source, { passes });
  const { standaloneTasks } = await import('./standalone-tasks.js');
  const jobs = await standaloneTasks([{type:'core',data:{source:folded.code}}]);
  const result = jobs.results[0];
  if (output) await fs.writeFile(output, result.code, 'utf8');
  else process.stdout.write(result.code);
  process.stderr.write(`Deobfuscated: ${result.stats.folds} folds, ${result.stats.properties} readable properties (${result.stats.passes} passes).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}
