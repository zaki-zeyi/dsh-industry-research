import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { UpdateSlots } from '../plugin/update-slots.mjs';

const root = resolve(import.meta.dirname, '..');
const baseVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const nextVersion = baseVersion.replace(/\d+$/, value => String(Number(value) + 1));
const source = resolve(root, `artifacts/dsh-industry-research-${baseVersion}`);
const temp = mkdtempSync(resolve(tmpdir(), 'industry-ota-host-'));
const profile = resolve(temp, 'profiles/ota-test');
const dataDir = resolve(temp, 'workbench');
const cli = process.env.DSH_CLI_PATH ? resolve(process.env.DSH_CLI_PATH) :
  resolve(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
let child;

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function boot(expectedVersion) {
  const port = await freePort();
  let log = '';
  child = spawn(process.execPath, ['--expose-internals', cli, '--profile', 'ota-test', '--patch',
    resolve(temp, 'patch.json'), '--no-open', '--port', String(port)], {
    env: { ...process.env, DSH_HOME: temp }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-5000); });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(`${url}/industry-research/status`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const status = await response.json();
        if (status.state === 'error') throw new Error(status.message);
        if (status.state === 'ready') {
          if (status.version !== expectedVersion) {
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
          }
          const health = await (await fetch(`${status.url}/api/health`)).json();
          assert.equal(health.version, expectedVersion);
          return;
        }
      }
    } catch (error) {
      if (error.name !== 'TimeoutError' && !/fetch failed|aborted due to timeout/.test(error.message)) throw error;
    }
    if (child.exitCode !== null) throw new Error(`DSH exited ${child.exitCode}: ${log}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`DSH startup timed out: ${log}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  child = null;
}

try {
  mkdirSync(resolve(profile, 'node_modules'), { recursive: true });
  cpSync(source, resolve(profile, 'node_modules/dsh-industry-research'), { recursive: true });
  writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ name: 'ota-test', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-industry-research'] } } }));
  writeFileSync(resolve(temp, 'patch.json'), JSON.stringify([{ id: 'dsh-industry-research', config: { dataDir, mode: 'demo' } }]));
  await boot(baseVersion);
  console.log('PASS: base bootstrap runs in actual DSH host');

  const updatePackage = resolve(temp, 'source/package');
  cpSync(source, updatePackage, { recursive: true });
  const manifestPath = resolve(updatePackage, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = nextVersion;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const archivePath = resolve(temp, 'candidate.tgz');
  const packed = spawnSync('tar', ['-czf', archivePath, 'package'], { cwd: resolve(temp, 'source'), encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const archive = readFileSync(archivePath);
  const candidate = { version: nextVersion, archive: { version: nextVersion, size: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex') } };
  const slots = new UpdateSlots(dataDir, baseVersion);
  await slots.schedule(archivePath, candidate);
  assert.equal(slots.activeVersion, baseVersion);
  await stop();
  await boot(nextVersion);
  assert.equal(new UpdateSlots(dataDir, baseVersion).state.lastResult.state, 'updated');
  console.log(`PASS: offline restart activates staged payload, installed DSH bundle stays ${baseVersion}`);

  await stop();
  const active = new UpdateSlots(dataDir, baseVersion);
  const runtimePath = resolve(active.slots, active.state.active.sha256, 'package/server/runtime.mjs');
  const sourceText = readFileSync(runtimePath, 'utf8');
  const brokenText = sourceText.replace(/const version = JSON\.parse\(readFileSync\([^;]+;/,
    "const version = '0.0.0';");
  assert.notEqual(brokenText, sourceText);
  writeFileSync(runtimePath, brokenText);
  await boot(baseVersion);
  const recovered = new UpdateSlots(dataDir, baseVersion);
  assert.equal(recovered.state.lastResult.state, 'restored');
  assert.equal(recovered.state.active.kind, 'base');
  console.log('PASS: unhealthy slot releases its runtime and rolls back without download or reinstall');
} finally {
  await stop();
  rmSync(temp, { recursive: true, force: true });
}
