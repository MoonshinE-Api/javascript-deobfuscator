#!/usr/bin/env node
import { main } from '../src/deobfuscate.js';

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
