import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
import {batchRename} from './batch-rename.js';
import {protectedGlobalBindings} from './global-renaming.js';
import {reserveName} from './reserve-name.js';
import {opaqueName as opaque, hexadecimalName} from './binding-names.js';
const traverse = traverseModule.default ?? traverseModule;
const key = node => node?.name ?? node?.value;
const camel = value => String(value).replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/)
  .filter(Boolean).map((part, index) => index ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part.toLowerCase()).join('');
const cleanRole = value => camel(value).replace(/^(?:get|create|read|collect|build)(?=[A-Z])/, '').replace(/^./, c => c.toLowerCase());

function functionPath(binding) {
  if (binding?.path.isFunction()) return binding.path;
  if (binding?.path.isVariableDeclarator() && binding.path.get('init').isFunction()) return binding.path.get('init');
  return null;
}

function features(p) {
  const props = new Set(), strings = new Set(), calls = new Set();
  p.traverse({ MemberExpression(ref) { if (!ref.node.computed) props.add(key(ref.node.property)); },
    StringLiteral(ref) { strings.add(ref.node.value); }, CallExpression(ref) {
      if (t.isIdentifier(ref.node.callee)) calls.add(ref.node.callee.name);
    } });
  return { props, strings, calls };
}

function functionRole(p) {
  const { props, strings, calls } = features(p);
  let ownXor=false,ownChars=false,ownCharCodes=false,keyScheduleBounds=0,localArrays=false;
  p.traverse({Function(inner){inner.skip();},BinaryExpression(inner){if(inner.node.operator==='^')ownXor=true;},
    MemberExpression(inner){const name=key(inner.node.property);if(name==='fromCharCode')ownChars=true;if(name==='charCodeAt')ownCharCodes=true;},
    NumericLiteral(inner){if(inner.node.value===256)keyScheduleBounds++;},ArrayExpression(){localArrays=true;}});
  if(ownXor&&ownChars&&ownCharCodes&&localArrays&&keyScheduleBounds>=3)return ['decodeRc4String',97,'256-entry state table, modular key schedule and XOR character reconstruction'];
  if(ownXor&&ownChars&&ownCharCodes)return ['decodeXorString',96,'combines character codes with XOR and reconstructs text'];
  if (props.has('currentScript') && props.has('querySelectorAll')) return ['readScriptMetadata', 96, 'reads currentScript and falls back to script selectors'];
  if (strings.has('file://') && strings.has('*')) return ['normalizeMessageOrigin', 94, 'uses a wildcard for file/null message origins'];
  if (props.has('getOwnPropertySymbols') && props.has('enumerable') && props.has('filter') && !props.has('defineProperties'))
    return ['getOwnPropertyKeys', 96, 'collects own string and symbol keys with an enumerable filter'];
  if (strings.has('aria-hidden') && props.has('setAttribute')) return ['setAriaHidden', 98, 'writes the aria-hidden attribute'];
  if (strings.has('class') && props.has('setAttribute') && !props.has('createElement')) return ['setElementClass', 98, 'writes the class attribute'];
  if (props.has('code') && (strings.has('Escape') || props.has('Escape')) && (strings.has('Backspace') || props.has('Backspace')) && props.has('push'))
    return ['createKeyboardEventHandler', 96, 'maps keyboard codes into buffered interaction records'];
  if (props.has('btoa') && props.has('join')) return ['serializeInteractionEvents', 96, 'joins interaction records and base64 encodes them'];
  if (props.has('timestamp') && props.has('now') && !props.has('push') && !props.has('map') && !props.has('setAttribute')
    && p.node.params.length === 0 && p.node.body.body?.some(statement => t.isExpressionStatement(statement)
      && t.isAssignmentExpression(statement.expression) && t.isArrayExpression(statement.expression.right)))
    return ['clearInteractionEvents', 95, 'clears event arrays and resets their timestamp'];
  if (props.has('documentMode') && props.has('onError')) return ['checkBrowserSupport', 94, 'checks documentMode and reports an unsupported browser'];
  if (props.has('default') && props.has('optional') && props.has('theme') && props.has('hasOwnProperty'))
    return ['resolveSettingsDefaults', 93, 'merges supplied settings with defaults and optional flags'];
  if (props.has('setup') && props.has('subTimerEnd') && calls.has('createChallengeState'))
    return ['initializeClientState', 90, 'sets up the event bus and tracks setup completion'];
  if (props.has('done') && props.has('value') && props.has('resolve') && p.node.params.length === 7)
    return ['advanceAsyncGenerator', 97, 'resolves generator results and continues asynchronous steps'];
  if ([...strings].some(value => value.startsWith('Invalid attempt to destructure non-iterable instance.')))
    return ['toDestructuredArray', 98, 'compiler helper for iterable destructuring'];
  if (strings.has('-wrapper') && props.has('concat') && p.node.params.length === 1)
    return ['buildWrapperClassName', 94, 'constructs a class name with a wrapper suffix'];
  if (p.node.params.length === 2 && p.node.params.every(param => t.isIdentifier(param))) {
    const [source, length] = p.node.params;
    let allocatesPrefix = false, copiesItems = false;
    p.traverse({ Function(inner) { inner.skip(); }, NewExpression(inner) {
      if (t.isIdentifier(inner.node.callee, {name:'Array'}) && !inner.scope.getBinding('Array')
        && inner.node.arguments.length === 1 && t.isIdentifier(inner.node.arguments[0], {name:length.name})) allocatesPrefix = true;
    }, AssignmentExpression(inner) {
      const {left,right}=inner.node;
      if (t.isMemberExpression(left) && left.computed && t.isMemberExpression(right) && right.computed
        && t.isIdentifier(right.object,{name:source.name}) && t.isIdentifier(left.property)
        && t.isIdentifier(right.property,{name:left.property.name})) copiesItems=true;
    } });
    if (allocatesPrefix && copiesItems) return ['copyArrayPrefix', 96, 'allocates a limited array and copies indexed source items'];
  }
  return null;
}

function expressionRole(node, p) {
  if(t.isStringLiteral(node)&&/^https?:\/\//.test(node.value))return ['endpointUrl',88,'literal HTTP URL'];
  if (t.isMemberExpression(node) && !node.computed && key(node.property)?.length > 3) return [camel(key(node.property)), 82, 'value read from .' + key(node.property)];
  if (t.isNewExpression(node) && t.isIdentifier(node.callee)) {
    const role = { Map: 'lookupMap', Set: 'uniqueValues', Date: 'date', Error: 'error', Promise: 'promise', RegExp: 'pattern', URL: 'url',
      XMLHttpRequest:'httpRequest',TextEncoder:'textEncoder',TextDecoder:'textDecoder',Uint8Array:'bytes',ArrayBuffer:'buffer',Worker:'worker',AbortController:'abortController' }[node.callee.name];
    if (role) return [role, 84, 'new ' + node.callee.name];
  }
  if (t.isRegExpLiteral(node)) return ['pattern', 90, 'regular expression literal'];
  if (t.isCallExpression(node)) {
    if(t.isIdentifier(node.callee,{name:'fetch'}))return ['responsePromise',86,'return value of fetch'];
    if (t.isFunction(node.callee) && p?.isVariableDeclarator() && p.get('init.callee').isFunction()) {
      const role = functionRole(p.get('init.callee'));
      if (role && role[0] === 'readScriptMetadata') return ['scriptMetadata', 96, 'result of the script-metadata initializer'];
    }
    if (t.isIdentifier(node.callee) && /^(get|create|read|collect|build)[A-Z]/.test(node.callee.name))
      return [cleanRole(node.callee.name), 78, 'result of ' + node.callee.name];
    if (t.isMemberExpression(node.callee) && !node.callee.computed) {
      const method = key(node.callee.property);
      const roles = { parse: 'parsedValue', stringify: 'jsonText', getOwnPropertySymbols: 'symbolKeys',
        getOwnPropertyDescriptor: 'propertyDescriptor', getOwnPropertyDescriptors: 'propertyDescriptors',
        querySelectorAll: 'matchedElements', match: 'matches', filter: 'filteredItems', reduce: 'reducedValue',
        getBoundingClientRect: 'boundingRect', now: 'timestamp', getRandomValues: 'randomValues',
        getItem:'storedValue',arrayBuffer:'responseBuffer',json:'responseData',text:'responseText',
        encode:'encodedBytes',decode:'decodedText',digest:'digestPromise',encrypt:'encryptionPromise',decrypt:'decryptionPromise' };
      if (roles[method]) return [roles[method], 84, 'result of .' + method];
      if (method === 'querySelector') return ['selectedElement', 86, 'querySelector result'];
      if (method === 'getAttribute' && t.isStringLiteral(node.arguments[0]))
        return [camel(node.arguments[0].value.replace(/^data-/, '')) + 'Attribute', 88, 'named DOM attribute'];
      if (method === 'n' && t.isIdentifier(node.callee.object) && /^requireModule\d*$/.test(node.callee.object.name)
        && t.isIdentifier(node.arguments[0]) && /^module\d+$/.test(node.arguments[0].name))
        return [node.arguments[0].name + 'Default', 94, 'Webpack default-export accessor'];
    }
  }
  if (t.isObjectExpression(node)) {
    const keys = node.properties.map(prop => key(prop.key));
    if (keys.includes('styleTagTransform') || keys.includes('insertStyleElement')) return ['styleLoaderOptions', 92, 'style-loader options'];
    if (keys.includes('publicKey') && keys.includes('onCompleted')) return ['clientConfigDefaults', 92, 'client config defaults'];
    if (keys.includes('show') && keys.includes('enforcementUrl')) return ['frameState', 92, 'frame visibility and URL state'];
    if (keys.includes('timestamp') && keys.includes('type') && keys.includes('code')) return ['keyboardRecord', 94, 'keyboard record fields'];
    if (keys.includes('timestamp') && keys.includes('x') && keys.includes('y')) return ['pointerRecord', 94, 'coordinate record fields'];
    if (keys.filter(value => typeof value === 'string' && /^(Tab|Enter|ShiftLeft|Escape|Backspace)$/.test(value)).length >= 3)
      return ['keyCodes', 92, 'key-name lookup table'];
  }
  return null;
}

function fresh(binding, wanted,names) {
  return reserveName(binding,wanted,names);
}

// This is a deterministic evidence-based namer, not a neural model. It edits
// bindings only; property keys and externally visible strings remain intact.
export function nameBindings(ast) {
  const stats = { engine: 'local JavaScript rules', renames: [], skipped: null };
  let dynamicScope = false;
  traverse(ast, { CallExpression(p) {
    if (t.isIdentifier(p.node.callee, { name: 'eval' })) dynamicScope = true;
  } });
  if (dynamicScope) { stats.skipped = 'eval can observe local names'; return stats; }
  for (let pass = 0; pass < 3; pass++) {
    // Rebuild after prior transforms and each propagation round.
    traverse(ast, { Program(p) { p.scope.crawl(); } });
    const plans = new Map();
    function suggest(binding, role) {
      if (!binding || !opaque(binding.identifier.name) || !role) return;
      const [name, confidence, reason] = role;
      if (!name || name.length < 4 || name.length > 64 || !t.isValidIdentifier(name)
        || ['eval', 'arguments', 'undefined'].includes(name) || confidence < 78) return;
      const previous = plans.get(binding);
      if (!previous || confidence > previous.confidence) plans.set(binding, { name, confidence, reason, ambiguous: false });
      else if (confidence === previous.confidence && name !== previous.name) previous.ambiguous = true;
    }
    traverse(ast, {
      Function(p) {
        const binding = p.isFunctionDeclaration() ? p.parentPath.scope.getBinding(p.node.id?.name)
          : p.parentPath.isVariableDeclarator() && t.isIdentifier(p.parentPath.node.id) ? p.parentPath.scope.getBinding(p.parentPath.node.id.name) : null;
        const role = functionRole(p);
        suggest(binding, role);
        const parameters = role && {
          normalizeMessageOrigin: ['origin'], copyArrayPrefix: ['source','length'],
          getOwnPropertyKeys: ['object','enumerableOnly'], setAriaHidden: ['hidden','state'],
          createKeyboardEventHandler: ['eventType'],
          advanceAsyncGenerator: ['generator','resolve','reject','nextStep','throwStep','method','argument'],
          decodeXorString:['encodedText','xorKey'],decodeRc4String:['encodedText','keyText']
        }[role[0]];
        if (parameters) p.node.params.forEach((param,index) => {
          if (t.isIdentifier(param) && parameters[index]) suggest(p.scope.getBinding(param.name), [parameters[index],95,'parameter role in '+role[0]]);
        });
      },
      VariableDeclarator(p) { if (t.isIdentifier(p.node.id)) suggest(p.scope.getBinding(p.node.id.name), expressionRole(p.node.init,p)); },
      CatchClause(p) { if (t.isIdentifier(p.node.param)) suggest(p.scope.getBinding(p.node.param.name), ['caughtError', 95, 'catch parameter']); },
      ObjectProperty(p) {
        if (!p.node.computed && t.isIdentifier(p.node.value) && key(p.node.key)?.length > 3)
          suggest(p.scope.getBinding(p.node.value.name), [camel(key(p.node.key)), 87, 'value of object field ' + key(p.node.key)]);
      },
      AssignmentExpression(p) {
        const { left, right } = p.node;
        if (t.isIdentifier(left)) suggest(p.scope.getBinding(left.name), expressionRole(right));
        if (t.isMemberExpression(left) && !left.computed && key(left.property)?.length > 3 && t.isIdentifier(right))
          suggest(p.scope.getBinding(right.name), [camel(key(left.property)), 87, 'assigned to field ' + key(left.property)]);
      },
      CallExpression(p) {
        const { callee, arguments: args } = p.node;
        const api=t.isIdentifier(callee)?callee.name:t.isMemberExpression(callee)&&!callee.computed?key(callee.property):null;
        const parameterRoles={fetch:['requestUrl','requestOptions'],getItem:['storageKey'],setItem:['storageKey','storedValue'],
          addEventListener:['eventType','eventHandler'],removeEventListener:['eventType','eventHandler'],
          querySelector:['selector'],querySelectorAll:['selector'],createElement:['tagName'],
          encode:['plainText'],decode:['encodedBytes'],parse:['jsonText'],stringify:['jsonValue'],
          fromCharCode:['characterCode'],charCodeAt:['characterIndex']};
        if(parameterRoles[api])args.forEach((arg,index)=>{if(t.isIdentifier(arg)&&parameterRoles[api][index])
          suggest(p.scope.getBinding(arg.name),[parameterRoles[api][index],89,'argument '+(index+1)+' of '+api]);});
        if (t.isIdentifier(callee)) {
          const fn = functionPath(p.scope.getBinding(callee.name));
          if (fn) args.forEach((arg, index) => {
            const param = fn.node.params[index];
            if (t.isIdentifier(param) && !opaque(param.name) && t.isIdentifier(arg))
              suggest(p.scope.getBinding(arg.name), [param.name, 80, 'passed as ' + param.name + ' to ' + callee.name]);
            if (t.isIdentifier(param) && t.isIdentifier(arg) && !opaque(arg.name)
              && !/^module\d+|^requireModule/.test(arg.name))
              suggest(fn.scope.getBinding(param.name), [arg.name, 79, 'caller passes ' + arg.name]);
          });
        }
        if (!t.isMemberExpression(callee) || callee.computed) return;
        const method = key(callee.property);
        if(['then','catch','finally','sort','replace','replaceAll'].includes(method)&&t.isFunction(args[0])){
          const callback=p.get('arguments.0'),roles={then:['resolvedValue'],catch:['caughtError'],finally:[],sort:['leftItem','rightItem']}[method]??['matchedText','captureGroup'];
          callback.node.params.forEach((param,index)=>{if(t.isIdentifier(param)&&roles[index])suggest(callback.scope.getBinding(param.name),[roles[index],91,'callback parameter of '+method]);});
        }
        if(['replace','replaceAll'].includes(method)&&t.isFunction(args[1])){
          const callback=p.get('arguments.1');callback.node.params.forEach((param,index)=>{if(t.isIdentifier(param))suggest(callback.scope.getBinding(param.name),[index?'captureGroup':'matchedText',91,'replacement callback parameter']);});
        }
        if(method==='addEventListener'&&t.isFunction(args[1])){
          const callback=p.get('arguments.1'),param=callback.node.params[0],event=t.isStringLiteral(args[0])?args[0].value:'';
          const role=event==='message'?'messageEvent':/^(key)/.test(event)?'keyboardEvent':/^(mouse|pointer|touch)/.test(event)?'pointerEvent':'receivedEvent';
          if(t.isIdentifier(param))suggest(callback.scope.getBinding(param.name),[role,94,'callback receives '+(event||'an')+' event']);
        }
        if (['forEach', 'map', 'filter', 'reduce'].includes(method) && t.isFunction(args[0])) {
          const callback = p.get('arguments.0');
          const source = callee.object;
          const isKeys = t.isCallExpression(source) && t.isMemberExpression(source.callee)
            && t.isIdentifier(source.callee.object, { name: 'Object' }) && t.isIdentifier(source.callee.property, { name: 'keys' });
          const index = method === 'reduce' ? 1 : 0;
          const param = callback.node.params[index];
          if (isKeys && t.isIdentifier(param)) suggest(callback.scope.getBinding(param.name), ['propertyKey', 91, 'iterates Object.keys']);
          const indexParam = callback.node.params[index + 1];
          if (t.isIdentifier(indexParam)) suggest(callback.scope.getBinding(indexParam.name), ['itemIndex', 92, 'array callback index']);
          if (method === 'reduce' && t.isIdentifier(callback.node.params[0])) suggest(callback.scope.getBinding(callback.node.params[0].name), ['accumulator', 92, 'reduce accumulator']);
        }
        if (method === 'setAttribute' && t.isStringLiteral(args[0]) && t.isIdentifier(args[1]))
          suggest(p.scope.getBinding(args[1].name), [camel(args[0].value) + 'Value', 90, 'value of DOM attribute ' + args[0].value]);
      },
      ForStatement(p){
        const init=p.node.init;
        if(t.isVariableDeclaration(init))for(const item of init.declarations){
          if(t.isIdentifier(item.id)&&t.isNumericLiteral(item.init)&&t.isUpdateExpression(p.node.update)&&t.isIdentifier(p.node.update.argument,{name:item.id.name}))
            suggest(p.scope.getBinding(item.id.name),['itemIndex',96,'numeric loop counter with an increment/decrement update']);
        }
      },
      Scopable(p) {
        for (const binding of Object.values(p.scope.bindings)) {
          if (binding.scope !== p.scope || !opaque(binding.identifier.name)) continue;
          const props = new Set();
          for (const ref of binding.referencePaths) if (ref.parentPath.isMemberExpression() && ref.parentPath.node.object === ref.node
            && !ref.parentPath.node.computed) props.add(key(ref.parentPath.node.property));
          if (props.has('prev') && props.has('next') && (props.has('abrupt') || props.has('stop'))) suggest(binding, ['generatorContext', 99, 'compiled generator state-machine methods']);
          if (props.has('done') && props.has('value')) suggest(binding, ['iteratorResult', 94, 'iterator result fields']);
          if (props.has('code') && !props.has('emit')) suggest(binding, ['keyboardEvent', 86, 'keyboard code access']);
          if (props.has('getAttribute') && props.has('src')) suggest(binding, ['scriptElement', 89, 'script src and attributes']);
          if (props.has('next') && props.has('return')) suggest(binding, ['iterator', 91, 'iterator protocol methods']);
          if (props.has('observability') && props.has('challengeCompleteTimeout')) suggest(binding, ['settings', 88, 'challenge settings fields']);
          if(props.has('charCodeAt'))suggest(binding,['encodedText',90,'text read as character codes']);
          if(props.has('byteLength')&&props.has('buffer'))suggest(binding,['byteView',90,'buffer and byte length accesses']);
          if(props.has('status')&&props.has('responseText'))suggest(binding,['httpRequest',92,'HTTP status and response text accesses']);
          if(hexadecimalName(binding.identifier.name)){
            const node=binding.path.node;
            if(t.isIdentifier(node)&&binding.kind==='param')suggest(binding,['parameter',78,'function parameter without a more specific inferred role']);
            else if(binding.path.isFunctionDeclaration())suggest(binding,['helperFunction',78,'local function without a more specific inferred role']);
            else if(binding.path.isVariableDeclarator()){
              const init=node.init;
              const name=t.isArrayExpression(init)?init.elements.length>=3&&init.elements.every(item=>t.isStringLiteral(item))?'stringTable':'items'
                :t.isObjectExpression(init)?'lookupObject':t.isFunction(init)?'callback':t.isStringLiteral(init)?'textValue':t.isNumericLiteral(init)?'numericValue':'localValue';
              suggest(binding,[name,78,'initializer shape; no application-specific role inferred']);
            }
          }
        }
      }
    });
    let count = 0;const names=new WeakMap(),renames=new Map();
    const protectedGlobals=protectedGlobalBindings(ast);
    for (const [binding, suggestion] of plans) {
      if (suggestion.ambiguous || protectedGlobals.has(binding)) continue;
      const from = binding.identifier.name, to = fresh(binding, suggestion.name,names);
      const line = binding.identifier.loc?.start.line ?? null;
      renames.set(binding,to);
      stats.renames.push({ from, to, confidence: suggestion.confidence / 100, reason: suggestion.reason, sourceLine: line });
      count++;
    }
    batchRename(ast,renames);
    if (!count) break;
  }
  return stats;
}
