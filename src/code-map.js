import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';
const traverse = traverseModule.default ?? traverseModule;
const key = node => node?.name ?? node?.value;
const cell = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');

export function codeMap(application, modules) {
  const lines = ['# Code map', '', 'Open [reader.html](../reader.html) first. [application.js](../src/application.js) contains client logic; [readable.js](../src/readable.js) includes bundled libraries; [formatted.js](../src/formatted.js) retains the earlier conservative pass.', '', 'Function names and roles are inferred from static code. Line numbers below refer to the generated application file.'];
  if (!application) return lines.join('\n') + '\n';
  const ast = parse(application, { sourceType: 'unambiguous' });
  const entry = ast.program.body.find(node => t.isExportDefaultDeclaration(node)
    && t.isFunctionDeclaration(node.declaration) && node.declaration.id?.name === 'clientEntry')?.declaration;
  const functions = [], events = [], api = [];
  traverse(ast, {
    Function(p) {
      const parent = p.parentPath;
      const name = p.isFunctionDeclaration() ? p.node.id?.name
        : parent.isVariableDeclarator() && t.isIdentifier(parent.node.id) ? parent.node.id.name : null;
      const functionParent = p.getFunctionParent();
      const allowed = entry ? functionParent?.node === entry : !functionParent
        || functionParent.parentPath.isCallExpression() && functionParent.parentPath.node.callee === functionParent.node && !functionParent.getFunctionParent();
      if (!name || p.node === entry || !allowed) return;
      const calls = new Set(), fields = new Set();
      p.traverse({ Function(inner) { inner.skip(); }, CallExpression(inner) {
        if (t.isIdentifier(inner.node.callee)) calls.add(inner.node.callee.name);
        else if (t.isMemberExpression(inner.node.callee) && !inner.node.callee.computed) {
          const callee = inner.node.callee;
          if (t.isIdentifier(callee.object)) calls.add(callee.object.name + '.' + key(callee.property));
        }
      }, MemberExpression(inner) {
        const node = inner.node;
        if (t.isIdentifier(node.object) && /challengeState/.test(node.object.name) && !node.computed) fields.add(key(node.property));
      } });
      functions.push({ name, line: p.node.loc.start.line, calls: [...calls].slice(0, 6), fields: [...fields].slice(0, 10) });
    },
    ObjectExpression(p) {
      const properties = p.node.properties;
      if (!properties.some(prop => key(prop.key) === 'setConfig') || !properties.some(prop => key(prop.key) === 'run')) return;
      for (const prop of properties) api.push({ name: key(prop.key), line: prop.loc.start.line });
    },
    CallExpression(p) {
      const node = p.node;
      if (!t.isMemberExpression(node.callee) || node.callee.computed || !t.isIdentifier(node.callee.object)
        || !/eventBus/.test(node.callee.object.name) || key(node.callee.property) !== 'on') return;
      const event = node.arguments[0], callback = node.arguments[1];
      events.push({ event: t.isStringLiteral(event) ? event.value : t.isIdentifier(event) ? event.name : 'computed event',
        handler: t.isIdentifier(callback) ? callback.name : 'inline handler', line: p.node.loc.start.line });
    }
  });
  lines.push('', '## Public API', '', '| Method | Line |', '| --- | ---: |');
  for (const entry of api) lines.push(`| ${cell(entry.name)} | ${entry.line} |`);
  lines.push('', '## Main functions', '', '| Function | Line | Calls | State fields used |', '| --- | ---: | --- | --- |');
  for (const fn of functions) lines.push(`| ${cell(fn.name)} | ${fn.line} | ${cell(fn.calls.join(', '))} | ${cell(fn.fields.join(', '))} |`);
  lines.push('', '## Event subscriptions', '', '| Event | Handler | Line |', '| --- | --- | ---: |');
  for (const entry of events) lines.push(`| ${cell(entry.event)} | ${cell(entry.handler)} | ${entry.line} |`);
  lines.push('', '## Bundled modules', '', '| Module | Imports | Literal export count |', '| ---: | --- | ---: |');
  for (const module of modules) lines.push(`| ${module.id} | ${module.dependencies.join(', ')} | ${Object.keys(module.literalExports).length} |`);
  return lines.join('\n') + '\n';
}
