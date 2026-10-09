# Contributing

Use Node.js 22 or newer. Install locked dependencies with `npm ci` and run `npm test` before submitting changes.

Transforms must account for initialization order, getters, mutated built-ins, aliases, side effects, dynamic scope and shared caches. If a transformation cannot establish its preconditions, retain the original expression. Prefer an unchanged expression over a plausible but incorrect result.

Add small synthetic regressions for supported patterns and the corresponding unsafe cases. Behavioral comparisons may execute trusted test fixtures in Node's VM; the production deobfuscator must never execute submitted code. Tests should verify observable results and side effects rather than merely reproduce transformation internals.

Keep complete-program outputs separate from analysis projections and function excerpts. Explain inferred names and unresolved cases in reports. Never treat shorter output or a decoded candidate as proof of runtime equivalence.

This repository is for offline deobfuscation. Session recording, browser instrumentation and live network execution belong outside its scope. Do not include captures, personal browser profiles, credentials or third-party production script dumps in contributions.
