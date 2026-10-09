#!/usr/bin/env node
import { main } from './src/unpack.js';

main().catch(error => {
  console.error(process.argv.includes('--debug') ? error.stack : `${error.message}\nUse --debug for the stack trace.`);
  process.exitCode = 1;
});
