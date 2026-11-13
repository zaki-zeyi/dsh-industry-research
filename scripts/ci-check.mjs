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
function run(command, args) {
  return new Promise(done => {
    const child = spawn(command, args, { env: { ...process.env, CI_ARTIFACT_DIR: resolve(directory, 'runtime') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
    child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
    child.on('error', error => { console.error(error.message); log.write(error.message); });
    child.on('close', code => done(code ?? 1));
  });
}
// Complete native-file preparation before parallel workers can load the DLL.
// Keep the wrapper usable from isolated test projects without this repository.
import { existsSync } from 'node:fs';
const prepare = resolve('scripts/prepare-pty.mjs');
const prepared = stage === 'test' && existsSync(prepare) ? await run(process.execPath, [prepare]) : 0;
process.exitCode = prepared || await run(command.command, command.args);
log.end();
