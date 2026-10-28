#!/usr/bin/env node
// `acc` launcher: run the TypeScript sources through tsx (no build step for internal packages).
import { register } from 'tsx/esm/api';

register();
const { run } = await import('../src/main.ts');
process.exitCode = await run(process.argv.slice(2));
