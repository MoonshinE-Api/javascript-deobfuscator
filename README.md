# Javascript Deobfuscator

[![MIT License](https://img.shields.io/badge/license-MIT-f5c542?logo=opensourceinitiative&logoColor=white)](LICENSE)
[![npm version](https://img.shields.io/npm/v/javascript-unpack?logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/javascript-unpack)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-43853d?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![GitHub issues](https://img.shields.io/github/issues/MoonshinE-Api/javascript-deobfuscator?logo=github)](https://github.com/MoonshinE-Api/javascript-deobfuscator/issues)

Make tangled JavaScript easier to read. Decode strings, simplify supported control flow, clean up names, then explore the result one function at a time.

Everything runs locally. The deobfuscator parses your input; it doesn't execute it or send it to a service.

## Install

Requires **Node.js 22 or newer**.

```sh
npm install -g javascript-unpack
```

The repository name is `javascript-deobfuscator`; the npm package name is `javascript-unpack`.

## Quick start

Get a single cleaned file:

```sh
js-deobfuscate input.js -o readable.js
```

Get the complete source, reports and a searchable reading desk:

```sh
js-deobfuscate-report input.js output
```

The report command creates several JavaScript files plus Markdown and JSON reports. It includes a fingerprint API inventory, decoded string tables, function indexes and dispatcher maps. The single-file command above only writes the cleaned JavaScript you request.

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
| `src/formatted.js` | A formatted source view for comparison. |
| `src/application.js` | The application view extracted from a recognized bundle, or the cleaned program for other inputs. |
| `src/human-reading.js` | A candidate reading projection with inferred names and exposed literals. It can change behavior; don't use it as a replacement program. |
| `src/functions/` | Individual function excerpts. Shared state and enclosing bindings remain in the full file. |
| `src/short-human-readable.js` | A small operation index with links back to complete source. |
| `src/extracted-code/` | Original and cleaned embedded code strings. |
| `src/modules/` | Extracted module factories when a supported bundle is recognized; they need the original bundle runtime. |
| `src/tasks/` | Code excerpts grouped into inferred reading tasks. |
| `src/reading-data/`, `src/reading-internals/`, `src/reading-paths/` | Decoded data, helper excerpts and candidate dispatcher paths when available. |
| `src/fingerprint-collection.js` | Line-numbered API evidence stored as inert strings, for inspection. |
| `reports/fingerprints.json` | Fingerprint categories, recognized API sites, operations, source locations and unresolved computed properties. |
| `reports/FINGERPRINTS.md` | A readable summary of the fingerprint inventory and its limits. |
| `reports/FUNCTIONS.md`, `reports/FUNCTIONS.json` | Function index and source references. |
| `reports/READABILITY.md`, `reports/READABILITY.json` | What changed and what still looks obfuscated. |
| `reports/STRING_DECODERS.md`, `reports/STRING_DECODERS.json` | Decoded dictionaries and cache limitations. |
| `reports/DISPATCHERS.md`, `reports/DISPATCHERS.json` | Recognized state machines and candidate paths. |
| `reports/HUMAN_READING.md`, `reports/HUMAN_READING.json` | Inferred names, reading projection details and limitations. |
| `reports/EMBEDDED_CODE.md`, `reports/EMBEDDED_CODE.json` | Embedded payload inventory and links to extracted files. |
| `reports/BEHAVIOR.md`, `reports/behavior.json` | Inferred behavior groups and reading journeys. |
| `reports/START_HERE.md`, `reports/BRIEF.md`, `reports/CODE_MAP.md`, `reports/ANALYSIS.md` | Entry points, code organization and analysis summaries. |
| `reports/report.json` | Transformation and worker statistics. |

The fingerprint inventory looks for canvas, WebGL, audio, browser/device properties, storage, event handlers and other recognized APIs. It reports **what the code references** with source evidence. It does not collect a live browser fingerprint, execute those APIs, or prove that a value was sent to a server. Extracted modules, payloads and reading paths depend on what the input contains; some folders can be empty.

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
npm install javascript-unpack
```

```js
import { unpack, fullReadable } from 'javascript-unpack';

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

## Credits

Maintained by **Rewq**.

**Discord:** `@rewq_7`
