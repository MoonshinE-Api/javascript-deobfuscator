# Changelog

## 17.0.0 — standalone source export

- Extracted the existing offline transformation pipeline and its dependencies into a standalone package.
- Preserved the complete `unpack()` transformation core.
- Retained the single-file CLI, report CLI, HTML reading desk, embedded-code extraction and candidate reading tools.
- Removed browser and simulation commands, session-capture modules, recording interfaces and their runtime dependencies.
- Retained the 2048 MiB worker old-space ceiling and bounded report scheduling.
- Added installation instructions, output distinctions, API documentation and a synthetic example.

This extraction does not claim a new deobfuscation improvement or superiority over other tools.
