import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {batchRename} from './batch-rename.js';
import {protectedGlobalBindings} from './global-renaming.js';
import {opaqueName as shortName} from './binding-names.js';
const traverse = traverseModule.default ?? traverseModule;

const keyOf = node => t.isIdentifier(node) ? node.name : t.isStringLiteral(node) ? node.value : null;
const words = value => String(value).replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const camel = value => words(value).toLowerCase().replace(/_([a-z0-9])/g, (_, letter) => letter.toUpperCase());

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

function constantName(key, value) {
  if (typeof value === 'string' && /^[A-Za-z][A-Za-z _-]{1,60}$/.test(value)) return words(value).toUpperCase();
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.includes('API_EXECUTE')) return 'METRIC_NAMES';
    if (keys.includes('ON_READY')) return 'TIMER_NAMES';
    if (keys.includes('API') && keys.includes('ENFORCEMENT')) return 'COMPONENT_NAMES';
    return 'CONSTANT_GROUP_' + words(key).toUpperCase();
  }
  if (typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)) return 'API_VERSION';
  return 'CONSTANT_' + words(key).toUpperCase();
}

// Evaluate namespace getters once into named aliases, retaining their values
// and object identities instead of copying or inventing properties.
function aliasExports(imports, exportMaps, stats) {
  for (const [binding, id] of imports) {
    if (!binding.constant || !binding.path.isVariableDeclarator()
      || !binding.path.parentPath.isVariableDeclaration() || !binding.path.parentPath.inList) continue;
    const map = exportMaps.get(id);
    if (!map || !Object.keys(map).length) continue;
    const declarations = [];
    const aliases = new Map();
    for (const reference of [...binding.referencePaths]) {
      const member = reference.parentPath;
      if (!member.isMemberExpression() || member.node.object !== reference.node) continue;
      const key = member.node.computed ? t.isStringLiteral(member.node.property) ? member.node.property.value : null : keyOf(member.node.property);
      if (!Object.hasOwn(map, key)) continue;
      const parent = member.parentPath;
      if (isWriteTarget(member) || (parent.isCallExpression() && parent.node.callee === member.node)
        || parent.isTaggedTemplateExpression() || parent.isNewExpression()) continue;
      if (member.node.start <= binding.path.node.end) continue;
      // Eager aliasing is only for reads in the declaration's function or its
      // nested callbacks; no expressions are moved across module boundaries.
      let name = aliases.get(key);
      if (!name) {
        name = binding.scope.generateUidIdentifier(constantName(key, map[key])).name;
        aliases.set(key, name);
        const getter = t.memberExpression(t.identifier(binding.identifier.name), t.stringLiteral(key), true);
        const declaration = t.variableDeclarator(t.identifier(name), getter);
        const summary = JSON.stringify(map[key]).replaceAll('*/', '* /');
        t.addComment(declaration, 'leading', ` ${summary.length <= 120 ? summary : 'Literal export ' + key} `);
        declarations.push(declaration);
        stats.exportAliases++;
      }
      if (member.node.trailingComments) member.node.trailingComments = member.node.trailingComments.filter(comment => !comment.value.includes('literal export:'));
      member.replaceWith(t.identifier(name));
      stats.aliasedReads++;
    }
    if (declarations.length) {
      const declaration = binding.path.parentPath;
      if (!declaration.isVariableDeclaration() || !declaration.inList) continue;
      const position = declaration.node.declarations.indexOf(binding.path.node);
      declaration.node.declarations.splice(position + 1, 0, ...declarations);
    }
  }
}

function simplifyPropertyBuilders(ast, imports, exportMaps, modulePaths, stats) {
  const importNodes = new Map([...imports].map(([binding, id]) => [binding.path.node, id]));
  const helpers = new Map();
  for (const { id, fn } of modulePaths) {
    const helperNames = new Set();
    fn.traverse({ FunctionDeclaration(p) {
      const params = p.node.params;
      if (params.length !== 3 || !params.every(param => t.isIdentifier(param)) || p.node.body.body.length !== 2) return;
      const [statement, returned] = p.node.body.body;
      if (!t.isReturnStatement(returned) || !t.isIdentifier(returned.argument, { name: params[0].name })
        || !t.isExpressionStatement(statement) || !t.isConditionalExpression(statement.expression)) return;
      const condition = statement.expression;
      if (!t.isBinaryExpression(condition.test, { operator: 'in' })
        || !t.isIdentifier(condition.test.right, { name: params[0].name })) return;
      const call = condition.consequent, assignment = condition.alternate;
      if (!t.isCallExpression(call) || !t.isMemberExpression(call.callee)
        || !t.isIdentifier(call.callee.object, { name: 'Object' }) || p.scope.getBinding('Object')
        || !t.isIdentifier(call.callee.property, { name: 'defineProperty' })
        || !t.isIdentifier(call.arguments[0], { name: params[0].name })
        || !t.isIdentifier(call.arguments[1], { name: params[1].name })
        || !t.isObjectExpression(call.arguments[2]) || !t.isAssignmentExpression(assignment, { operator: '=' })
        || !t.isMemberExpression(assignment.left) || !assignment.left.computed
        || !t.isIdentifier(assignment.left.object, { name: params[0].name })
        || !t.isIdentifier(assignment.left.property, { name: params[1].name })
        || !t.isIdentifier(assignment.right, { name: params[2].name })) return;
      const descriptors = call.arguments[2].properties;
      if (descriptors.length !== 4 || !descriptors.every(prop => t.isObjectProperty(prop) && !prop.computed
        && (keyOf(prop.key) === 'value' ? t.isIdentifier(prop.value, { name: params[2].name })
          : ['enumerable', 'configurable', 'writable'].includes(keyOf(prop.key)) && t.isBooleanLiteral(prop.value, { value: true })))) return;
      helperNames.add(p.node.id.name);
    } });
    if (!helperNames.size) continue;
    fn.traverse({ ObjectProperty(p) {
      if (!t.isFunction(p.node.value) || !t.isBlockStatement(p.node.value.body)) return;
      const body = p.node.value.body.body;
      if (body.length === 1 && t.isReturnStatement(body[0]) && t.isIdentifier(body[0].argument)
        && helperNames.has(body[0].argument.name)) {
        if (!helpers.has(id)) helpers.set(id, new Set());
        helpers.get(id).add(keyOf(p.node.key));
      }
    } });
  }
  function helperCall(p, node) {
    if (!t.isCallExpression(node) || node.arguments.length !== 3 || node.arguments.some(arg => t.isSpreadElement(arg))) return false;
    let callee = node.callee;
    if (t.isSequenceExpression(callee) && callee.expressions.length === 2 && t.isNumericLiteral(callee.expressions[0], { value: 0 })) callee = callee.expressions[1];
    if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.object)) return false;
    const module = importNodes.get(p.scope.getBinding(callee.object.name)?.path.node);
    return helpers.get(module)?.has(keyOf(callee.property));
  }
  function primitiveKey(p, node, seen = new Set()) {
    if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) return true;
    if (t.isIdentifier(node)) {
      const binding = p.scope.getBinding(node.name);
      if (!binding?.constant || !binding.path.isVariableDeclarator() || seen.has(binding)) return false;
      return primitiveKey(binding.path, binding.path.node.init, new Set([...seen, binding]));
    }
    if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.object)) {
      const module = importNodes.get(p.scope.getBinding(node.object.name)?.path.node);
      const value = exportMaps.get(module)?.[keyOf(node.property)];
      return value === null || ['string', 'number', 'boolean'].includes(typeof value);
    }
    return false;
  }
  function build(p, node, baseBinding = null) {
    if (t.isObjectExpression(node)) return node.properties.slice();
    if (baseBinding && t.isIdentifier(node) && p.scope.getBinding(node.name) === baseBinding) return [];
    if (!helperCall(p, node)) return null;
    const previous = build(p, node.arguments[0], baseBinding);
    if (!previous) return null;
    // Literal primitive keys need no user-defined toPrimitive conversion.
    const key = node.arguments[1];
    if (!primitiveKey(p, key)) return null;
    return [...previous, t.objectProperty(key, node.arguments[2], true)];
  }
  traverse(ast, { WithStatement(p){p.skip();}, SequenceExpression: { exit(p) {
    const parts = p.node.expressions;
    if (parts.length < 2 || !t.isAssignmentExpression(parts[0], { operator: '=' })
      || !t.isIdentifier(parts[0].left) || !t.isObjectExpression(parts[0].right) || parts[0].right.properties.length) return;
    const binding = p.scope.getBinding(parts[0].left.name);
    const groups = parts.slice(1).map(part => build(p, part, binding));
    if (groups.some(group => !group)) return;
    const props = groups.flat();
    if (!props?.length) return;
    // Do not delay assignment to the empty accumulator if a key/value reads it.
    const referenced = props.some(prop => {
      let found = false;
      t.traverseFast(prop, node => { if (t.isIdentifier(node, { name: parts[0].left.name })) found = true; });
      return found;
    });
    if (referenced) return;
    p.replaceWith(t.assignmentExpression('=', parts[0].left, t.objectExpression(props)));
    stats.propertyBuilders++;
  } }, CallExpression: { exit(p) {
    if (!helperCall(p, p.node)) return;
    const props = build(p, p.node);
    if (!props) return;
    p.replaceWith(t.objectExpression(props));
    stats.propertyBuilders++;
  } } });
}

function inferNames(ast, stats) {
  const suggestions = new Map();
  function suggest(binding, name, score, evidence) {
    if (!binding || !shortName(binding.identifier.name) || !name || name.length < 4 || name.length > 60) return;
    if (!t.isValidIdentifier(name) || ['undefined', 'arguments', 'eval'].includes(name)) return;
    if ((suggestions.get(binding)?.score ?? 0) >= score) return;
    suggestions.set(binding, { name, score, evidence });
  }
  function suggestNode(node, p, name, score, evidence) {
    if (t.isIdentifier(node)) suggest(p.scope.getBinding(node.name), name, score, evidence);
  }
  function functionBinding(p) {
    if (p.isFunctionDeclaration()) return p.parentPath.scope.getBinding(p.node.id?.name);
    if (p.parentPath.isVariableDeclarator()) return p.parentPath.scope.getBinding(p.parentPath.node.id.name);
    return null;
  }
  traverse(ast, {
    ObjectProperty(p) {
      const key = !p.node.computed && keyOf(p.node.key);
      if (key && key.length > 3) suggestNode(p.node.value, p, camel(key), 85, 'object property ' + key);
    },
    AssignmentExpression(p) {
      if (t.isMemberExpression(p.node.left) && !p.node.left.computed) {
        const key = keyOf(p.node.left.property);
        if (key && key.length > 3) suggestNode(p.node.right, p, camel(key), 85, 'assigned to .' + key);
      }
    },
    VariableDeclarator(p) {
      if (!t.isIdentifier(p.node.id)) return;
      const binding = p.scope.getBinding(p.node.id.name), init = p.node.init;
      if (t.isMemberExpression(init) && !init.computed && keyOf(init.property)?.length > 3)
        suggest(binding, camel(keyOf(init.property)), 80, 'reads .' + keyOf(init.property));
      if (t.isStringLiteral(init) && /^[a-zA-Z][a-zA-Z _-]{3,40}$/.test(init.value))
        suggest(binding, camel(init.value) + 'Name', 45, 'string value');
      if (t.isCallExpression(init) && t.isMemberExpression(init.callee)) {
        const key = keyOf(init.callee.property);
        const first = init.arguments[0];
        if (key === 'createElement' && t.isStringLiteral(first)) suggest(binding, camel(first.value) + 'Element', 95, 'document.createElement');
        if (key === 'getAttribute' && t.isStringLiteral(first)) suggest(binding, camel(first.value.replace(/^data-/, '')), 90, 'attribute name');
        if (key === 'querySelector' && t.isStringLiteral(first)) suggest(binding, camel(first.value) + 'Element', 90, 'selector');
        if (key === 'getEntries') suggest(binding, 'performanceEntries', 90, 'performance entries');
        if (key === 'keys') suggest(binding, 'propertyKeys', 65, 'Object.keys');
        if (key === 'split') suggest(binding, 'textParts', 65, 'split result');
      }
      if (t.isArrayExpression(init) && init.elements.length === 0) suggest(binding, 'items', 25, 'empty array');
      if (t.isObjectExpression(init)) {
        const keys = init.properties.map(prop => keyOf(prop.key));
        if (keys.includes('setConfig') && keys.includes('run')) suggest(binding, 'clientApi', 110, 'public API methods');
        if (keys.includes('enabled') && keys.includes('samplePercentage')) suggest(binding, 'metricsOptions', 100, 'metrics options');
      }
      if (t.isConditionalExpression(init) && t.isObjectExpression(init.alternate)) {
        let usesArguments = false;
        t.traverseFast(init.test, node => { if (t.isIdentifier(node, { name: 'arguments' })) usesArguments = true; });
        if (usesArguments) suggest(binding, 'options', 75, 'arguments default');
      }
      if (t.isCallExpression(init) && init.arguments.some(argument => t.isFunctionExpression(argument))) {
        const constructor = init.arguments.find(argument => t.isFunctionExpression(argument));
        let fields = new Set();
        t.traverseFast(constructor.body, node => {
          if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left) && t.isThisExpression(node.left.object)) fields.add(keyOf(node.left.property));
        });
        if (fields.has('completed') && fields.has('token')) suggest(binding, 'ChallengeResult', 110, 'challenge result constructor');
      }
    },
    CallExpression(p) {
      if (t.isMemberExpression(p.node.callee) && !p.node.callee.computed && t.isIdentifier(p.node.callee.property, { name: 'on' })
        && t.isIdentifier(p.node.arguments[1])) {
        const event = p.node.arguments[0];
        const name = t.isStringLiteral(event) ? event.value : t.isIdentifier(event) ? event.name.replace(/^_+/, '') : null;
        if (name) suggestNode(p.node.arguments[1], p, 'handle' + camel(name).replace(/^./, letter => letter.toUpperCase()), 75, 'event subscription');
      }
    },
    ForStatement(p) {
      const init = p.node.init;
      if (t.isVariableDeclaration(init) && init.declarations.length === 1 && t.isIdentifier(init.declarations[0].id)
        && t.isNumericLiteral(init.declarations[0].init)) suggestNode(init.declarations[0].id, p, 'index', 55, 'loop counter');
    },
    Function(p) {
      const binding = functionBinding(p);
      const properties = new Set(), strings = [];
      let returnedObject, returnsTypeof = false, createsState = false, checksFunction = false;
      p.traverse({
        Function(inner) { inner.skip(); },
        StringLiteral(inner) { strings.push(inner.node.value); },
        MemberExpression(inner) { if (!inner.node.computed) properties.add(keyOf(inner.node.property)); },
        ObjectExpression(inner) {
          const keys = inner.node.properties.map(prop => keyOf(prop.key));
          if (keys.includes('isActive') && keys.includes('enforcementReady')) createsState = true;
        },
        ReturnStatement(inner) {
          if (t.isObjectExpression(inner.node.argument)) returnedObject = inner.node.argument;
          if (t.isUnaryExpression(inner.node.argument, { operator: 'typeof' })) returnsTypeof = true;
          const expr = inner.node.argument;
          if (t.isBinaryExpression(expr) && ['==', '==='].includes(expr.operator)
            && ((t.isStringLiteral(expr.left, { value: 'function' }) && t.isUnaryExpression(expr.right, { operator: 'typeof' }))
              || (t.isStringLiteral(expr.right, { value: 'function' }) && t.isUnaryExpression(expr.left, { operator: 'typeof' })))) checksFunction = true;
        }
      });
      if (strings.some(s => s.startsWith('Cannot call a class as a function'))) suggest(binding, 'assertClassInstance', 100, 'class guard');
      if (strings.some(s => s.startsWith('Invalid attempt to destructure'))) suggest(binding, 'toDestructuredArray', 100, 'Babel array helper');
      if (returnsTypeof) suggest(binding, 'getValueType', 90, 'typeof return');
      if (checksFunction) suggest(binding, 'isFunction', 100, 'function type predicate');
      if (properties.has('original') && properties.has('copy') && properties.has('isArray')) suggest(binding, 'cloneValue', 100, 'recursive clone records');
      if (properties.has('getOwnPropertyDescriptors') && properties.has('defineProperties')) suggest(binding, 'mergeObjects', 100, 'object spread helper');
      if (properties.has('propertyIsEnumerable') && p.node.params.length === 2) suggest(binding, 'omitProperties', 95, 'object rest helper');
      if (properties.has('split') && properties.has('forEach') && strings.includes('.') && p.node.params.length === 3)
        suggest(binding, 'getPropertyPath', 100, 'dot path traversal');
      if (properties.has('domainLookupEnd') && returnedObject) suggest(binding, 'getResourceTiming', 95, 'performance timing fields');
      if (properties.has('getEntries')) suggest(binding, 'collectPerformanceMetrics', 95, 'performance entries');
      if (properties.has('setAttribute') && properties.has('createElement')) suggest(binding, 'createContainerElement', 95, 'DOM creation');
      if (createsState) suggest(binding, 'createChallengeState', 110, 'challenge state initializer');
      if (properties.has('onReadyEventCheck') && properties.has('push')) suggest(binding, 'handleReadyEvent', 110, 'readiness tracking');
      if (properties.has('events') && properties.has('apply')) suggest(binding, 'dispatchCallback', 100, 'callback invocation');
      if (properties.has('appendChild') && properties.has('contains') && properties.has('mode')) suggest(binding, 'mountChallengeContainer', 100, 'container mounting');
      if (properties.has('setSession') && properties.has('split')) suggest(binding, 'updateSessionToken', 100, 'session token split');
      if (properties.has('isConfigured') && properties.has('styleTheme')) suggest(binding, 'applyClientConfig', 100, 'configuration updates');
      if (p.parentPath.isObjectProperty()) {
        const name = keyOf(p.parentPath.node.key);
        if (name && name.length > 3) {
          // Name delegates used by the public API, rather than anonymous wrappers.
          if (t.isBlockStatement(p.node.body) && p.node.body.body.length === 1) {
            const statement = p.node.body.body[0];
            const expr = t.isReturnStatement(statement) ? statement.argument : t.isExpressionStatement(statement) ? statement.expression : null;
            if (t.isCallExpression(expr)) suggestNode(expr.callee, p, camel(name) + 'Handler', 95, 'delegated method ' + name);
            if (t.isIdentifier(expr)) suggestNode(expr, p, camel(name), 100, 'export getter ' + name);
          }
        }
      }
    },
    Scopable(p) {
      for (const binding of Object.values(p.scope.bindings)) {
        if (binding.scope !== p.scope || !shortName(binding.identifier.name)) continue;
        const props = new Set();
        for (const ref of binding.referencePaths) {
          if (ref.parentPath.isMemberExpression() && ref.parentPath.node.object === ref.node && !ref.parentPath.node.computed)
            props.add(keyOf(ref.parentPath.node.property));
        }
        if (props.has('enforcementReady') || props.has('onReadyEventCheck')) suggest(binding, 'challengeState', 120, 'challenge state fields');
        else if (props.has('timerStart') || props.has('subTimerEnd')) suggest(binding, 'metricsObserver', 110, 'timer methods');
        else if (props.has('emit') && props.has('on')) suggest(binding, 'eventBus', 110, 'event emitter methods');
        else if (props.has('responseEnd') || props.has('domainLookupEnd')) suggest(binding, 'performanceEntry', 100, 'performance timing');
        else if (props.has('config') && props.has('events')) suggest(binding, 'state', 80, 'config and events');
        else if (props.has('stack') && props.has('message')) suggest(binding, 'error', 90, 'error fields');
        else if (props.has('getAttribute') || props.has('setAttribute')) suggest(binding, 'element', 70, 'DOM attributes');
        else if (props.has('split') || props.has('charCodeAt')) suggest(binding, 'text', 50, 'string methods');
        else if (props.has('push') && !props.has('emit')) suggest(binding, 'items', 40, 'array methods');
        else if (props.has('samplePercentage')) suggest(binding, 'metricsConfig', 95, 'sampling configuration');
        else if (props.has('pageX') && props.has('pageY')) suggest(binding, 'pointerEvent', 90, 'pointer coordinates');
        else if (props.has('touches')) suggest(binding, 'touchEvent', 90, 'touch event fields');
        else if (props.has('code') && props.has('keyCode')) suggest(binding, 'keyboardEvent', 90, 'keyboard event fields');
        else if (props.has('token') && props.has('width')) suggest(binding, 'eventData', 65, 'event fields');
        else if (props.has('token') || props.has('observability') || props.has('target')) suggest(binding, 'eventData', 60, 'event fields');
        else if (props.has('publicKey') && props.has('selector')) suggest(binding, 'config', 80, 'configuration fields');
      }
    }
  });
  const renames=new Map();
  const protectedGlobals=protectedGlobalBindings(ast);
  for (const [binding, suggestion] of suggestions) {
    if(protectedGlobals.has(binding))continue;
    const from = binding.identifier.name;
    const to = binding.scope.generateUidIdentifier(suggestion.name).name;
    renames.set(binding,to);
    stats.renames.push({ from, to, reason: suggestion.evidence });
  }
  batchRename(ast,renames);
}

function expandControlFlow(ast, stats) {
  function expand(expr) {
    if (t.isSequenceExpression(expr)) {
      stats.expandedSequences++;
      return expr.expressions.flatMap(expand);
    }
    if (t.isLogicalExpression(expr) && (expr.operator === '&&' || expr.operator === '||')) {
      stats.expandedConditions++;
      const condition = expr.operator === '&&' ? expr.left : t.unaryExpression('!', expr.left, true);
      return [t.ifStatement(condition, t.blockStatement(expand(expr.right)))];
    }
    if (t.isConditionalExpression(expr)) {
      stats.expandedConditions++;
      return [t.ifStatement(expr.test, t.blockStatement(expand(expr.consequent)), t.blockStatement(expand(expr.alternate)))];
    }
    return [t.expressionStatement(expr)];
  }
  function replace(p, nodes) {
    t.inheritsComments(nodes[0], p.node);
    if (p.inList) p.replaceWithMultiple(nodes);
    else p.replaceWith(t.blockStatement(nodes));
  }
  traverse(ast, {
    WithStatement(p){p.skip();},
    ExpressionStatement: { exit(p) {
      const expr = p.node.expression;
      if (t.isSequenceExpression(expr) || t.isConditionalExpression(expr)
        || t.isLogicalExpression(expr) && expr.operator !== '??') replace(p, expand(expr));
    } },
    ReturnStatement: { exit(p) {
      const expr = p.node.argument;
      if (t.isSequenceExpression(expr)) {
        stats.expandedSequences++;
        const items = expr.expressions.slice(), last = items.pop();
        replace(p, [...items.flatMap(expand), t.returnStatement(last)]);
      } else if (t.isConditionalExpression(expr)) {
        stats.expandedConditions++;
        replace(p, [t.ifStatement(expr.test, t.blockStatement([t.returnStatement(expr.consequent)]), t.blockStatement([t.returnStatement(expr.alternate)]))]);
      }
    } },
    IfStatement: { exit(p) {
      // The comma test has to be evaluated exactly once, immediately before if.
      if (t.isSequenceExpression(p.node.test)) {
        const parts = p.node.test.expressions.slice();
        p.node.test = parts.pop();
        stats.expandedSequences++;
        replace(p, [...parts.flatMap(expand), p.node]);
        return;
      }
      if (!t.isBlockStatement(p.node.consequent)) p.node.consequent = t.blockStatement([p.node.consequent]);
      if (p.node.alternate && !t.isBlockStatement(p.node.alternate) && !t.isIfStatement(p.node.alternate))
        p.node.alternate = t.blockStatement([p.node.alternate]);
    } },
    VariableDeclaration: { exit(p) {
      if (p.node.declarations.length <= 1 || !p.inList) return;
      const nodes = p.node.declarations.map(declaration => {
        const statement = t.variableDeclaration(p.node.kind, [declaration]);
        if (declaration.leadingComments) { statement.leadingComments = declaration.leadingComments; delete declaration.leadingComments; }
        return statement;
      });
      replace(p, nodes);
      stats.splitDeclarations++;
    } }
  });
}

export function humanize(ast, { imports, exportMaps, modulePaths, onStage=()=>{} }) {
  const stats = { exportAliases: 0, aliasedReads: 0, renames: [], expandedConditions: 0, expandedSequences: 0, splitDeclarations: 0, propertyBuilders: 0 };
  let dynamic = false;
  traverse(ast, { CallExpression(p) {
    if (t.isIdentifier(p.node.callee, { name: 'eval' })) dynamic = true;
  } });
  if (dynamic) return { ...stats, skipped: 'Direct eval prevents reliable name inference.' };
  imports = new Map([...imports].map(([binding, id]) => [binding.path.scope.getBinding(binding.identifier.name), id]).filter(([binding]) => binding));
  simplifyPropertyBuilders(ast, imports, exportMaps, modulePaths, stats);
  // Property builders can replace whole subtrees. Their old reference paths
  // are detached, even when an import declaration itself is still present.
  traverse(ast, { Program(p) { p.scope.crawl(); p.stop(); } });
  imports = new Map([...imports].map(([binding, id]) => [binding.path.scope.getBinding(binding.identifier.name), id]).filter(([binding]) => binding));
  aliasExports(imports, exportMaps, stats);
  traverse(ast, { Program(p) { p.scope.crawl(); p.stop(); } });
  onStage('Infer binding roles');inferNames(ast, stats);
  onStage('Expand readable control flow');expandControlFlow(ast, stats);
  return stats;
}
