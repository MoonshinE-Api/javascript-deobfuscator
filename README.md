# Rewq JavaScript Deobfuscator

[![MIT License](https://img.shields.io/badge/license-MIT-f5c542?logo=opensourceinitiative&logoColor=white)](LICENSE)
[![npm version](https://img.shields.io/npm/v/rewq-js-deobfuscator?logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/rewq-js-deobfuscator)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-43853d?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![GitHub issues](https://img.shields.io/github/issues/MoonshinE-Api/javascript-deobfuscator?logo=github)](https://github.com/MoonshinE-Api/javascript-deobfuscator/issues)

Make tangled JavaScript easier to read. Decode strings, simplify supported control flow, clean up names, then explore the result one function at a time.

Everything runs locally. The deobfuscator parses your input; it doesn't execute it or send it to a service.

## Install

Requires **Node.js 22 or newer**.

```sh
npm install -g rewq-js-deobfuscator
```

The repository name is `javascript-deobfuscator`; the npm package name is `rewq-js-deobfuscator`.

## Quick start

Get a single cleaned file:

```sh
js-deobfuscate input.js -o readable.js
```

Get the complete source, reports and a searchable reading desk:

```sh
js-deobfuscate-report input.js output
```

Open **`output/reader.html`**. Follow function links, search for API calls, inspect decoded dictionaries, or jump back to the full source.

For large files, independent reports can run in parallel:

```sh
js-deobfuscate-report input.js output --max-cpu
```

Both report modes run the deep transformation passes. `--max-cpu` changes report scheduling; it doesn't make dependent transforms parallel.

## A small example

Before:

```js
globalThis.message = "hel" + "lo" + String.fromCharCode(32) + atob("d29ybGQ=");
```

After:

```js
globalThis.message = "hello world";
```

Real files are usually messier. A decoder might share a cache, a helper might have side effects, or a dispatcher might depend on unknown state. When a supported transform can't establish its preconditions, the expression stays in the program.

## What it can clean up

- **Strings:** constant expressions, common encoding calls, recognized string tables and rotations, decoder wrappers, and supported Base91 caches.
- **Helpers:** supported primitive functions, proxy objects and constant property lookups.
- **Control flow:** constant branches, supported ordered dispatchers, unreachable statements and unused local code.
- **Names and layout:** inferred binding names, direct properties, clearer statements and function notes.
- **Code inside strings:** statically recoverable `eval`, `Function` and timer payloads, saved separately for inspection.
- **Reading tools:** function excerpts, call links, async stages, dispatcher maps, source references and before/after readability measurements.

The goal is code you can work through, not the smallest line count. Expanding several operations onto separate lines can make a file longer and easier to follow.

## Which file should I open?

| File in `output/` | What it's for |
| --- | --- |
| `reader.html` | Start here: searchable functions, reports and source links. |
| `src/readable.js` | The complete transformed program. |
| `src/full-human-readable.js` | The same transformed structure with expanded statements. |
| `src/human-reading.js` | A candidate reading projection with inferred names and exposed literals. It can change behavior; don't use it as a replacement program. |
| `src/functions/` | Individual function excerpts. Shared state and enclosing bindings remain in the full file. |
| `src/short-human-readable.js` | A small operation index with links back to complete source. |
| `src/extracted-code/` | Original and cleaned embedded code strings. |
| `reports/READABILITY.md` | What changed and what still looks obfuscated. |
| `reports/STRING_DECODERS.md` | Decoded dictionaries and cache limitations. |
| `reports/report.json` | Transformation and worker statistics. |

Inferred names are clues, not recovered original names. Custom virtual machines and unknown dynamic code aren't automatically reconstructed. The expanded layout is checked against the cleaned program's parsed structure; that isn't a proof of equivalence to every original input.

## Other ways to use it

Read stdin and write to stdout:

```sh
js-deobfuscate - < input.js > readable.js
```

Set the initial literal-folding pass count (1–30):

```sh
js-deobfuscate input.js -o readable.js --passes 16
```

Use `--help` on either command. The report command also accepts `--debug` for an error stack.

From JavaScript:

```sh
npm install rewq-js-deobfuscator
```

```js
import { unpack, fullReadable } from 'rewq-js-deobfuscator';

const result = unpack('globalThis.answer = 20 + 22;');
console.log(result.code);
console.log(result.stats);

const expanded = fullReadable(result.code);
```

`unpack()` runs the complete pipeline synchronously. `deobfuscate()` is also exported as the smaller literal-folding API; the installed CLI runs the full pipeline.

## Memory

CLI workers have a **2048 MiB (2 GiB) old-space heap ceiling**. Small inputs start at 512 MiB and retry at 2048 MiB after a recognized heap failure. Larger inputs start at 2048 MiB.

That is a worker heap limit, not a cap on total RAM. Buffers, native allocations, the parent process and other workers need memory too. `--max-cpu` schedules at most four report workers according to available RAM.

The synchronous API runs in your own process. Configure its Node heap separately if needed.

## Working on the source

```sh
git clone https://github.com/MoonshinE-Api/javascript-deobfuscator.git
cd javascript-deobfuscator
npm ci
npm test
node unpack.js examples/obfuscated.js output
```

The tests use small, trusted fixtures. Browser recording and session capture aren't part of this package. See [CONTRIBUTING.md](CONTRIBUTING.md) for transform guidelines and [CHANGELOG.md](CHANGELOG.md) for release notes.

Found a case that stays obfuscated, or a transform that changes behavior? [Open an issue](https://github.com/MoonshinE-Api/javascript-deobfuscator/issues) with a small reproducible example and the expected result.

## License

[MIT](LICENSE) · Copyright (c) 2026 Rewq.

Dependencies keep their own licenses.
