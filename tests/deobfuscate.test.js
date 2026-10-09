import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deobfuscate } from '../src/deobfuscate.js';

test('decodes strings, numeric expressions, properties and offset tables', () => {
  const { code, stats } = deobfuscate("const a=['\\x68ello','world']; function d(i){return a[i-0x10]} console['lo'+'g'](d(0x10), a[1], (5 ^ 3) + 2, ![]);");
  assert.match(code, /console\.log\("hello", "world", 8, !\[\]\)/);
  assert.ok(stats.folds >= 4);
});
test('does not execute input', () => {
  globalThis.__deobfuscatorExecuted = false;
  deobfuscate('globalThis.__deobfuscatorExecuted = true; throw new Error("executed")');
  assert.equal(globalThis.__deobfuscatorExecuted, false);
  delete globalThis.__deobfuscatorExecuted;
});
test('keeps mutated and escaping tables intact', () => {
  for (const operation of ['a[0]="y"', '[a[0]]=["y"]', 'a.push("y")', 'unknown(a)']) {
    const { code } = deobfuscate(`const a=["x"]; ${operation}; use(a[0]);`);
    assert.match(code, /use\(a\[0\]\)/);
  }
});
test('does not fold uncertain initialization or dynamic bindings', () => {
  for (const source of [
    'use(a[0]); var a=["x"];',
    'if (condition) { var a=["x"]; } use(a[0]);',
    'const a=["x"]; function f(){use(a[0]);}',
    'const a=["x"]; eval(source); use(a[0]);'
  ]) assert.match(deobfuscate(source).code, /use\(a\[0\]\)/);
});
test('preserves special numeric behavior and side effects', () => {
  const { code } = deobfuscate('use(-0, 1/0, 0/0, (sideEffect(), 3));');
  assert.match(code, /-0/);
  assert.match(code, /1 \/ 0/);
  assert.match(code, /0 \/ 0/);
  assert.match(code, /sideEffect\(\)/);
});
test('all reads of one constant table fold in a pass, including repeated decoder calls',()=>{
 const source=`const t=['a','b','c'];function d(i){return t[i];}use(t[0],t[1],t[2],d(0),d(1),d(2));`;
 const out=deobfuscate(source,{passes:1});assert.match(out.code,/use\("a", "b", "c", "a", "b", "c"\)/);
});
