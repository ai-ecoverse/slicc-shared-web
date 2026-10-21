#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') process.exit(0);
const script = fileURLToPath(new URL('slicc-install-hooks.sh', import.meta.url));
const run = spawnSync('sh', [script, ...process.argv.slice(2)], { stdio: 'inherit' });
if (run.error) throw run.error;
process.exit(run.status ?? 1);
