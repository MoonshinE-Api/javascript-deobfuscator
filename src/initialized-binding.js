// A later-created closure cannot observe a top-level function-body const before
// its initializer. Hoisted function declarations do not establish that order.
export function initializedFor(binding, reference, seen = new Set()) {
  if (seen.size > 40) return false;
  if (!binding?.path.isVariableDeclarator()) return false;
  const declaration = binding.path.parentPath, container = declaration.parentPath;
  const tryBody=container.isBlockStatement()&&container.parentPath.isTryStatement()&&container.key==='block'
    &&!!reference.findParent(parent=>parent===container);
  if (!declaration.isVariableDeclaration() || !(container.isProgram()||tryBody
    || container.isBlockStatement() && container.parentPath.isFunction() && container.key === 'body')) return false;
  const end = binding.path.node.end, start = reference.node.start;
  if (end == null || start == null || end >= start) return false;
  const owner = binding.path.getFunctionParent();
  if (owner === reference.getFunctionParent()) return true;
  for (let cursor = reference.parentPath; cursor; cursor = cursor.parentPath) {
    if ((cursor.isFunctionExpression() || cursor.isArrowFunctionExpression() || cursor.isClassDeclaration() || cursor.isClassExpression())
      && cursor.getFunctionParent() === owner && cursor.node.start != null && cursor.node.start > end) return true;
  }
  for (let fn = reference.getFunctionParent(); fn && fn !== owner; fn = fn.getFunctionParent()) {
    if (!fn.isFunctionDeclaration() || !fn.node.id) continue;
    if (seen.has(fn.node)) return true;
    const fnBinding = fn.parentPath.scope.getBinding(fn.node.id.name);
    if (fnBinding && !fnBinding.scope.path.isProgram() && fnBinding.referencePaths.length) {
      const next = new Set([...seen, fn.node]);
      // Every read/escape of this local function must itself happen after the
      // initializer. Recursive groups are safe only if all external reads are.
      const valid = fnBinding.referencePaths.every(ref => initializedFor(binding, ref, next));
      if (valid) return true;
    }
  }
  return false;
}
