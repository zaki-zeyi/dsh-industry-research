import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { npmCommand } from './npm-command.mjs';

const stage = process.argv[2];
if (!['build', 'test', 'test:e2e', 'plugin:pack', 'plugin:check-pack'].includes(stage)) throw new Error('Unknown CI stage');
const directory = resolve('artifacts/diagnostics');
mkdirSync(directory, { recursive: true });
const log = createWriteStream(resolve(directory, stage.replaceAll(':', '-') + '.log'));
const command = npmCommand(['run', stage]);
const child = spawn(command.command, command.args, { env: { ...process.env, CI_ARTIFACT_DIR: resolve(directory, 'runtime') }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
child.on('error', error => { console.error(error.message); log.end(error.message); process.exitCode = 1; });
child.on('close', code => { log.end(); process.exitCode = code ?? 1; });
