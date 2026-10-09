# Changelog

## 17.0.0 — standalone source export

- Published the package as `javascript-unpack`; the GitHub repository remains `javascript-deobfuscator`.
- Expanded the output guide to list fingerprint evidence, JSON inventories, dispatcher maps and other generated reading files.
- Prepared the public `rewq-js-deobfuscator` npm package with a runtime-only file list and MIT license.
- Added an unconditional CLI wrapper so installed commands work through package-manager symlinks.
- Updated the README with npm/MIT badges, installed commands, a before/after example and clearer output guidance.
- Extracted the existing offline transformation pipeline and its dependencies into a standalone package.
- Preserved the complete `unpack()` transformation core.
- Retained the single-file CLI, report CLI, HTML reading desk, embedded-code extraction and candidate reading tools.
- Removed browser and simulation commands, session-capture modules, recording interfaces and their runtime dependencies.
- Retained the 2048 MiB worker old-space ceiling and bounded report scheduling.
- Added installation instructions, output distinctions, API documentation and a synthetic example.

This extraction does not claim a new deobfuscation improvement or superiority over other tools.
