import { spawn } from 'node:child_process';
const children = [spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.mjs'], { stdio: 'inherit', env: { ...process.env, RESEARCH_MODE: process.env.RESEARCH_MODE ?? 'demo' } }), spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; children.forEach(c => c.kill('SIGTERM')); process.exitCode = code; }
children.forEach(c => c.on('exit', code => stop(code ?? 1)));
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
