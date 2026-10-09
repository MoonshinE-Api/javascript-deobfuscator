# Rewq JavaScript Deobfuscator

An offline JavaScript deobfuscator that turns supported obfuscation patterns into clearer source and builds a searchable reading desk for large programs.

This repository contains the standalone static deobfuscator. Submitted JavaScript is parsed, never executed by the deobfuscation pipeline. Browser recording, session capture, network proxies, browser profiles and runtime tracing are excluded.

## Requirements and installation

Use Node.js 22 or newer and npm.

```sh
npm ci
npm test
```

Only four direct dependencies are required: Babel's parser, traversal library, AST types and code generator. No browser installation, model, API key or remote service is required to deobfuscate files.

## Deobfuscate a file

Write the complete cleaned program to one file:

```sh
node src/deobfuscate.js input.js -o readable.js
```

Read standard input and write cleaned JavaScript to standard output:

```sh
node src/deobfuscate.js - < input.js > readable.js
```

The single-file CLI uses the full transformation pipeline. Its `--passes=N` option controls the initial literal-folding pass count (1–30); the subsequent pipeline still runs its deeper transforms.

Build the complete source, reports and local HTML reading desk:

```sh
node unpack.js input.js output
node unpack.js input.js output --max-cpu
```

Open `output/reader.html` in your browser. The viewer displays input as inert text; it does not run the submitted JavaScript. Run `node unpack.js --help` for options. Add `--debug` to show an error stack.

Try the included synthetic example:

```sh
node unpack.js examples/obfuscated.js output
```

Its cleaned result assigns `"hello world"` to `globalThis.result`. No captured scripts or third-party production samples are included.

You can optionally use `npm link` to install the local `js-deobfuscate` and `js-deobfuscate-report` commands.

## What the pipeline handles

- Literal folding, string concatenation, supported encoding calls and constant conditions.
- Recognized string tables, rotations, decoder wrappers and cached Base91 decoders, with checks for shared-cache behavior.
- Supported primitive helper and proxy calls, with guards for side effects, dynamic scope, getters and initialization order.
- Supported ordered dispatchers, control-flow cleanup, unreachable statements and unused local bindings.
- More descriptive inferred binding and function names, readable properties and statement layout.
- Statically recoverable embedded code strings and module excerpts.
- Function indexes, call links, compiled async reading stages, dispatcher maps and exact source references.
- Static API inventories and readability measurements before and after transformation.

Pattern recognition is deliberately limited. Unsupported custom virtual machines, unknown dynamic values and unresolved control flow remain in the complete program.

## Which output should I read?

| Output | Purpose |
| --- | --- |
| `src/readable.js` | Complete transformed program. |
| `src/full-human-readable.js` | Complete transformed program with expanded statements; its parsed structure is checked against `readable.js`. |
| `src/formatted.js` | Earlier conservative formatting and literal-folding result. |
| `src/human-reading.js` | Candidate analysis projection with inferred names and exposed literals. It can change semantics and must not replace the complete program. |
| `src/functions/` | Individual function excerpts; their enclosing bindings remain in the complete program. |
| `src/short-human-readable.js` | Small operation index with source references, not a complete executable program. |
| `src/extracted-code/` | Original and readable versions of statically recovered code strings. |
| `reports/READABILITY.md` | Before/after measurements and remaining obstacles. |
| `reports/STRING_DECODERS.md` | Recognized decoded dictionaries and cache limitations. |
| `reports/report.json` | Transformation, output and worker metadata. |

Line count is not a quality score: expanding compressed statements can increase lines while exposing their structure. Names, titles and behavioral descriptions are local syntax-based inferences. The tool does not recover original variable names or guarantee original-input behavior for every possible program. Compare trusted fixtures or validate in your own authorized test environment before relying on transformed code.

## Memory and performance

CLI transformations run in child workers with an old-space heap ceiling of **2048 MiB (2 GiB)**. Small inputs start with 512 MiB and retry with 2048 MiB after a recognized memory failure. Larger inputs start with 2048 MiB.

The limit applies to the Node worker's old-space heap, not total process RAM. Native allocations, buffers, the parent process and other workers use additional memory. `--max-cpu` runs independent report tasks in parallel with RAM-aware scheduling (at most four workers). Dependent transformation stages run sequentially. Deep transforms are enabled by both report modes.

## Programmatic API

```js
import { unpack, fullReadable } from './index.js';

const result = unpack('globalThis.answer = 20 + 22;');
console.log(result.code);
console.log(result.stats);
const expanded = fullReadable(result.code);
```

`unpack()` is synchronous and returns the complete cleaned code, formatted code, extracted application/modules, statistics and embedded-code analysis. The API runs in your calling process; the 2 GiB worker ceiling belongs to the CLI worker runner. For the API, configure your Node process heap as appropriate.

`deobfuscate()` is also exported as a lower-level literal-folding API. Its CLI additionally runs the complete pipeline.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md). Tests include trusted synthetic fixtures and CLI integration checks; they do not require network access or browser recording.

## License

A license has not been selected by the repository owner. The package is marked `UNLICENSED` and private for npm publication. Dependencies retain their own licenses. Public GitHub hosting does not change the package's npm publication setting.
