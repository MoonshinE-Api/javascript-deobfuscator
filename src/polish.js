import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {batchRename} from './batch-rename.js';
import {protectedGlobalBindings} from './global-renaming.js';
import {reserveName} from './reserve-name.js';
import {hexadecimalName} from './binding-names.js';
const traverse = traverseModule.default ?? traverseModule;
const key = node => node?.name ?? node?.value;
const scopeNames = new WeakMap();

function freshName(binding, wanted) {
  if (wanted === binding.identifier.name) return wanted;
  return reserveName(binding,wanted,scopeNames);
}

function features(fn, deep = false) {
  const props = new Set(), strings = new Set(), identifiers = new Set();
  fn.traverse({ Function(p) { if (!deep) p.skip(); }, MemberExpression(p) { if (!p.node.computed) props.add(key(p.node.property)); },
    ObjectProperty(p) { if (!p.node.computed) props.add(key(p.node.key)); },
    StringLiteral(p) { strings.add(p.node.value); },
    ReferencedIdentifier(p) { identifiers.add(p.node.name.replace(/^_+/, '').replace(/\d+$/, '')); } });
  return { props, strings, identifiers };
}

function functionRole(p) {
  const { props, strings, identifiers } = features(p);
  const nested = features(p, true);
  if (props.has('currentScript') || (p.node.params.length <= 1 && props.has('getAttribute') && nested.props.has('currentScript'))) return 'readScriptMetadata';
  if (strings.has('file://') && strings.has('*')) return 'normalizeMessageOrigin';
  if (props.has('prototype') && props.has('defineProperty') && props.has('writable') && p.node.params.length === 3) return 'defineClass';
  if (props.has('defineProperty') && props.has('enumerable') && props.has('configurable') && p.node.params.length === 2) return 'defineClassMethods';
  if (props.has('enforcementReady') && props.has('isHidden') && props.has('emit') && !props.has('config') && !props.has('onReadyEventCheck')) return 'showChallenge';
  if (props.has('appendChild') && props.has('bodyClicked') && props.has('escapePressed')) return 'mountChallengeContainer';
  if (props.has('savedActiveElement') && props.has('modifiedSiblings')) return 'hideChallenge';
  if (props.has('removeEventListener') && props.has('logWindowError') && props.has('setup')) return 'initializeClient';
  if (props.has('getRandomValues')) return 'generateClientId';
  if (props.has('capiObserver') && props.has('isActive') && props.has('isReady') && !props.has('emit')) return 'updateChallengeFrame';
  if (props.has('samplePercentage') && props.has('subTimerStart') && props.has('getItem')) return 'createMetricsObserver';
  if (p.node.params.length <= 2 && nested.props.has('toPrimitive') && nested.strings.has('@@toPrimitive must return a primitive value.')) return p.node.params.length === 2 ? 'toPrimitive' : 'toPropertyKey';
  if (props.has('defineProperty') && props.has('writable') && p.node.params.length === 3) return 'defineDataProperty';
  if (p.node.params.length === 1 && props.has('iterator') && nested.props.has('constructor')
    && nested.strings.has('symbol') && nested.strings.has('function')) return 'typeOf';
  if (props.has('logError') && !props.has('timerStart') && p.node.params.length === 1) return 'handleClientError';
  if (props.has('source') && props.has('error') && props.has('status') && p.node.params.length === 1) return 'normalizeErrorDetails';
  if (strings.has('px') && strings.has('vw') && strings.has('vh')) return 'normalizeCssDimension';
  if (identifiers.has('ARK') && props.has('defineProperty') && p.node.params.length === 2) return 'ensureClientRegistry';
  if (identifiers.has('ARK') && p.node.params.length === 4) return 'setClientRegistryValue';
  if (p.node.params.length === 1 && nested.props.has('pageX') && nested.props.has('sqrt')) return 'createPointerEventHandler';
  if (p.node.params.length === 1 && nested.props.has('touches') && nested.props.has('floor')) return 'createTouchEventHandler';
  if (p.node.params.length === 1 && nested.props.has('code') && nested.strings.has('Escape')) return 'createKeyboardEventHandler';
  if (props.has('btoa') && nested.props.has('join') && p.node.params.length === 0) return 'serializeInteractionEvents';
  if ([...strings].some(value => value.startsWith('arkose-')) && props.has('concat') && p.node.params.length === 1) return 'buildContainerClassName';
  return null;
}

function domainNames(ast, stats) {
  const seen = new Set(),renames=new Map();
  const protectedGlobals=protectedGlobalBindings(ast);
  function rename(binding, wanted, reason) {
    if (!binding || seen.has(binding) || !wanted || protectedGlobals.has(binding)) return;
    seen.add(binding);
    const previous = binding.identifier.name;
    const next = freshName(binding, wanted);
    if (next === previous) return;
    renames.set(binding,next);
    stats.renames.push({ from: previous, to: next, reason });
  }
  traverse(ast, {
    Function(p) {
      let binding;
      if (p.isFunctionDeclaration()) binding = p.parentPath.scope.getBinding(p.node.id?.name);
      else if (p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parentPath.node.id)) binding = p.parentPath.scope.getBinding(p.parentPath.node.id.name);
      const role = functionRole(p);
      if (binding && /^[a-zA-Z_$]{1,3}$/.test(binding.identifier.name)) rename(binding, role, 'function body features');
      const functionName = role ?? binding?.identifier.name.replace(/^_+/, '').replace(/\d+$/, '')
        ?? (p.parentPath.isObjectProperty() || p.parentPath.isObjectMethod() ? key(p.parentPath.node.key) : null);
      const parameters = {
        defineClass: ['Constructor', 'prototypeMethods', 'staticMethods'],
        defineClassMethods: ['target', 'descriptors'],
        assertClassInstance: ['instance', 'Constructor'],
        defineDataProperty: ['target', 'propertyKey', 'value'],
        typeOf: ['value'], toPropertyKey: ['value'], toPrimitive: ['value', 'preferredType'],
        normalizeMessageOrigin: ['origin'], normalizeCssDimension: ['dimension'],
        ensureClientRegistry: ['target', 'clientId'], setClientRegistryValue: ['target', 'clientId', 'property', 'value'],
        normalizeErrorDetails: ['details'], handleClientError: ['error'],
        dispatchCallback: ['eventName'], buildContainerClassName: ['publicKey'],
        timerStart: ['timerId'], timerEnd: ['timerId'], subTimerStart: ['timerId', 'metricId'], subTimerEnd: ['timerId', 'metricId'],
        setSession: ['sessionId'], setPublicKey: ['publicKey'], setCAPIConfig: ['config'],
        logWindowError: ['category', 'message', 'filename', 'stack']
      }[functionName];
      if (parameters) p.node.params.forEach((param, index) => {
        if (t.isIdentifier(param) && parameters[index]) rename(p.scope.getBinding(param.name), parameters[index], 'parameter role in ' + functionName);
      });
    },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id) || !/^[a-zA-Z_$]{1,3}$/.test(p.node.id.name)) return;
      const binding = p.scope.getBinding(p.node.id.name);
      const init = p.node.init;
      if (t.isArrayExpression(init) && init.elements.some(element => t.isStringLiteral(element, { value: 'publicKey' }))
        && init.elements.some(element => t.isStringLiteral(element, { value: 'onCompleted' }))) rename(binding, 'configOptionNames', 'configuration allowlist');
      if (t.isAssignmentExpression(init) && t.isObjectExpression(init.right)) {
        const props = init.right.properties.map(prop => prop.value?.name ?? prop.value?.value);
        if (props.some(value => typeof value === 'string' && /onCompleted/.test(value))) rename(binding, 'callbackNamesByEvent', 'callback dispatch map');
      }
      if (t.isObjectExpression(init) && init.properties.some(prop => key(prop.key) === 'noop')
        && init.properties.some(prop => key(prop.key) === 'publicKey')) rename(binding, 'configValidators', 'configuration validators');
      if (t.isObjectExpression(init) && init.properties.some(prop => key(prop.key) === 'timestamp')
        && init.properties.filter(prop => /^[0-9a-f]{10}$/.test(key(prop.key))).length >= 3) rename(binding, 'interactionEvents', 'interaction event buffers');
      if (t.isMemberExpression(init) && init.computed && t.isIdentifier(init.object, { name: 'descriptors' }))
        rename(binding, 'descriptor', 'class method descriptor');
    },
    MemberExpression(p) {
      if (!p.node.computed && t.isIdentifier(p.node.object) && key(p.node.property) === 'apply') {
        const binding = p.scope.getBinding(p.node.object.name);
        if (binding && /^[a-zA-Z_$]{1,3}$/.test(binding.identifier.name)) rename(binding, 'callback', 'function invocation through apply');
      }
    }
  });
  batchRename(ast,renames);
}

// Give compiler imports descriptive accessors while retaining live exports.
// Reads through these facades still invoke the original namespace getter.
function nameCompilerImports(ast, modulePaths, stats) {
  const roles = new Map();
  for (const { id, fn } of modulePaths) {
    fn.traverse({ ObjectProperty(p) {
      const getter = p.get('value');
      if (!getter.isFunction() || !t.isBlockStatement(getter.node.body) || getter.node.params.length) return;
      const body = getter.node.body.body;
      if (body.length !== 1 || !t.isReturnStatement(body[0]) || !t.isIdentifier(body[0].argument)) return;
      const binding = getter.scope.getBinding(body[0].argument.name);
      if (!binding || !binding.path.isFunctionDeclaration()) return;
      const role = functionRole(binding.path);
      if (!['typeOf', 'toPropertyKey', 'defineDataProperty'].includes(role)) return;
      if (!roles.has(id)) roles.set(id, new Map());
      roles.get(id).set(key(p.node.key), role);
    } });
  }
  const imports = [];
  traverse(ast, { VariableDeclarator(p) {
    const init = p.node.init;
    if (t.isCallExpression(init) && t.isIdentifier(init.callee) && init.arguments.length === 1
      && t.isNumericLiteral(init.arguments[0]) && t.isIdentifier(p.node.id)
      && roles.has(init.arguments[0].value) && /requireModule/.test(init.callee.name)) imports.push(p);
  } });
  for (const p of imports) {
    if (!p.parentPath.inList) continue;
    const map = roles.get(p.node.init.arguments[0].value);
    const binding = p.scope.getBinding(p.node.id.name);
    if (!binding?.constant) continue;
    const refs = [...binding.referencePaths];
    const facadeName = freshName(binding, [...map.values()][0] + 'Helpers');
    const members = [];
    for (const [exportName, role] of map) {
      const read = t.memberExpression(t.identifier(binding.identifier.name), t.stringLiteral(exportName), true);
      members.push(t.objectMethod('get', t.identifier(role), [], t.blockStatement([t.returnStatement(read)])));
    }
    let used = false;
    for (const ref of refs) {
      const member = ref.parentPath;
      if (!member.isMemberExpression() || member.node.object !== ref.node || member.node.computed) continue;
      const role = map.get(key(member.node.property));
      if (!role) continue;
      const parent = member.parentPath;
      // A direct method call depends on its original receiver.
      if ((parent.isCallExpression() && parent.node.callee === member.node)
        || parent.isNewExpression() || parent.isTaggedTemplateExpression()
        || parent.isAssignmentExpression() || parent.isUpdateExpression()
        || parent.isUnaryExpression({ operator: 'delete' }) || parent.isArrayPattern() || parent.isObjectProperty()) continue;
      member.replaceWith(t.memberExpression(t.identifier(facadeName), t.identifier(role)));
      used = true;
      stats.namedHelperReads++;
    }
    if (used) {
      const declaration = t.variableDeclaration('var', [t.variableDeclarator(t.identifier(facadeName), t.objectExpression(members))]);
      t.addComment(declaration, 'leading', ' Named accessors for live compiler exports. ');
      p.parentPath.insertAfter(declaration);
      stats.helperFacades++;
    }
  }
}

function cleanNames(ast, stats) {
  const bindings = new Set(),renames=new Map();
  const protectedGlobals=protectedGlobalBindings(ast);
  traverse(ast, { Scopable(p) { for (const binding of Object.values(p.scope.bindings)) bindings.add(binding); } });
  // Independent functions can use the same local names; do not allocate all
  // identifiers in one global numbering sequence.
  for (const binding of [...bindings].reverse()) {
    if(protectedGlobals.has(binding))continue;
    const from = binding.identifier.name;
    // Removing the underscore from _0xabc yields an invalid identifier.
    // Leave these for the role-based namer instead of spinning in freshName.
    if(hexadecimalName(from))continue;
    if (!/^_[A-Za-z]/.test(from)) continue;
    let wanted = from.replace(/^_+/, '');
    if (/^module_\d+_exports\d*$/.test(wanted)) wanted = wanted.replace(/^module_(\d+)_exports\d*$/, 'module$1');
    else if (/^(module|exports|requireModule)\d*$/.test(wanted)) wanted = wanted.replace(/\d+$/, '');
    else wanted = wanted.replace(/\d+$/, '');
    const to = freshName(binding, wanted);
    if (from === to) continue;
    renames.set(binding,to);
    stats.renames.push({ from, to, reason: 'local naming cleanup' });
  }
  batchRename(ast,renames);
}

function simplifyExpressions(ast, stats) {
  function expressions(node) {
    if (t.isSequenceExpression(node)) return node.expressions.flatMap(expressions);
    if (t.isLogicalExpression(node) && ['&&', '||'].includes(node.operator)) {
      const test = node.operator === '&&' ? node.left : t.unaryExpression('!', node.left, true);
      return [t.ifStatement(test, t.blockStatement(expressions(node.right)))];
    }
    if (t.isConditionalExpression(node)) return [t.ifStatement(node.test, t.blockStatement(expressions(node.consequent)), t.blockStatement(expressions(node.alternate)))];
    return [t.expressionStatement(node)];
  }
  traverse(ast, {
    WithStatement(p){p.skip();},
    UnaryExpression(p) {
      if (p.node.operator === 'void' && t.isNumericLiteral(p.node.argument, { value: 0 }) && !p.scope.getBinding('undefined')) {
        p.replaceWith(t.identifier('undefined'));
        stats.undefinedExpressions++;
      }
    },
    BinaryExpression(p) {
      const node = p.node;
      const primitiveLiteral = value => t.isStringLiteral(value) || t.isNumericLiteral(value)
        || t.isBooleanLiteral(value) || t.isNullLiteral(value) || t.isBigIntLiteral(value);
      if (!primitiveLiteral(node.left) || t.isLiteral(node.right)) return;
      const operators = { '===': '===', '!==': '!==', '==': '==', '!=': '!=', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };
      if (!operators[node.operator]) return;
      const left = node.left;
      node.left = node.right;
      node.right = left;
      node.operator = operators[node.operator];
      stats.reorderedComparisons++;
    },
    ReturnStatement: { exit(p) {
      if (!t.isUnaryExpression(p.node.argument, { operator: 'void' })) return;
      const nodes = [...expressions(p.node.argument.argument), t.returnStatement()];
      if (p.inList) p.replaceWithMultiple(nodes);
      else p.replaceWith(t.blockStatement(nodes));
      stats.expandedVoidReturns++;
    } },
    'ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement': { exit(p) {
      if (!t.isBlockStatement(p.node.body)) {
        p.node.body = t.blockStatement([p.node.body]);
        stats.bracedLoops++;
      }
    } }
  });
}

export function polish(ast, { modulePaths }) {
  const stats = { renames: [], helperFacades: 0, namedHelperReads: 0, undefinedExpressions: 0, reorderedComparisons: 0, expandedVoidReturns: 0, bracedLoops: 0 };
  let dynamic = false;
  traverse(ast, { CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' })) dynamic = true; } });
  if (dynamic) return { ...stats, skipped: 'Direct eval prevents reliable name inference.' };
  nameCompilerImports(ast, modulePaths, stats);
  traverse(ast, { Program(p) { p.scope.crawl(); p.stop(); } });
  domainNames(ast, stats);
  cleanNames(ast, stats);
  simplifyExpressions(ast, stats);
  return stats;
}
