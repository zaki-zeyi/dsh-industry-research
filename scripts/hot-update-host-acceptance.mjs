import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';

const root = resolve(import.meta.dirname, '..');
const base = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const versionAt = delta => base.replace(/\d+$/, n => String(Number(n) + delta));
const source = resolve(root, `artifacts/dsh-industry-research-${base}`);
const temp = mkdtempSync(resolve(tmpdir(), 'industry-hot-host-'));
const profile = resolve(temp, 'profiles/hot-test'), dataDir = resolve(temp, 'data');
const cli = process.env.DSH_CLI_PATH ?? resolve(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/lib/bin.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let child, log = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, label) {
  const deadline = Date.now() + 90000;
  let latest;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Host exited: ${log}`);
    try { latest = await read(); if (predicate(latest)) return latest; } catch {}
    await sleep(150);
  }
  throw new Error(`${label}: ${JSON.stringify(latest)}\n${log}`);
}
async function candidate(delta, broken = false) {
  const version = versionAt(delta), dir = resolve(temp, `candidate-${delta}`);
  const packageDir = resolve(dir, 'package');
  cpSync(source, packageDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
  manifest.version = version; writeFileSync(resolve(packageDir, 'package.json'), JSON.stringify(manifest));
  if (broken) {
    const file = resolve(packageDir, 'server/runtime.mjs');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/const version = JSON\.parse\(readFileSync\([^;]+;/, "const version = '0.0.0';"));
  }
  const archive = resolve(dir, 'update.tgz');
  const packed = spawnSync('tar', ['-czf', archive, 'package'], { cwd: dir, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive), name = `dsh-industry-research-${version}.tgz`;
  const updateManifest = JSON.stringify({ schema: 'dsh-industry-research/update/v1', name: 'dsh-industry-research',
    version, sourceCommit: 'a'.repeat(40), installCommit: 'b'.repeat(40), installTag: `plugin-install-v${version}`,
    archiveName: name, archiveSize: bytes.length, archiveSha256: digest(bytes) });
  const release = { tag_name: `v${version}`, immutable: true, target_commitish: 'a'.repeat(40),
    published_at: '2026-11-20T00:00:00Z', assets: [
      { name: 'update-manifest.json', digest: `sha256:${digest(updateManifest)}`, browser_download_url: 'https://mock.invalid/update-manifest.json' },
      { name, size: bytes.length, digest: `sha256:${digest(bytes)}`,
        browser_download_url: `https://github.com/zaki-zeyi/dsh-industry-research/releases/download/v${version}/${name}` },
    ] };
  writeFileSync(resolve(temp, 'release.json'), JSON.stringify({ archive, release, manifest: updateManifest }));
  return version;
}

try {
  mkdirSync(resolve(profile, 'node_modules'), { recursive: true });
  cpSync(source, resolve(profile, 'node_modules/dsh-industry-research'), { recursive: true });
  writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ name: 'hot-test', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-industry-research'] } } }));
  // Only this disposable host substitutes network responses; production has no test update source.
  writeFileSync(resolve(temp, 'network.mjs'), `import {readFileSync} from 'node:fs';
export const name='update-acceptance-network';
export function apply(ctx,config){const original=globalThis.fetch;
globalThis.fetch=async (input,options)=>{const url=String(input);if(url.startsWith('https://api.github.com/repos/zaki-zeyi/dsh-industry-research/releases/')||url.startsWith('https://mock.invalid/')||url.startsWith('https://github.com/zaki-zeyi/dsh-industry-research/releases/download/')){
const value=JSON.parse(readFileSync(config.path,'utf8'));return new Response(url.includes('api.github.com')?JSON.stringify(value.release):url.includes('mock.invalid')?value.manifest:readFileSync(value.archive));}return original(input,options);};
ctx.effect(()=>()=>{globalThis.fetch=original;});}`);
  writeFileSync(resolve(temp, 'patch.json'), JSON.stringify([
    { insert: [{ id: 'acceptance-network', name: resolve(temp, 'network.mjs'), config: { path: resolve(temp, 'release.json') } }] },
    { id: 'dsh-industry-research', config: { dataDir, mode: 'demo' } },
  ]));
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done));
  await candidate(1);
  child = spawn(process.execPath, ['--expose-internals', cli, '--profile', 'hot-test', '--patch', resolve(temp, 'patch.json'),
    '--no-open', '--port', String(port)], { env: { ...process.env, DSH_HOME: temp }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-10000); });
  const host = `http://127.0.0.1:${port}`, pid = child.pid;
  const status = () => fetch(host + '/industry-research/status').then(r => r.json());
  const initial = await until(status, s => s.state === 'ready' && s.version === base, 'base ready');
  const url = initial.url;
  const snapshot = () => fetch(url + '/api/plugin-update').then(r => r.json());
  async function update(expected, result) {
    // Packaging blocks this test process long enough for pooled HTTP sockets to
    // expire. Reconnect read-only probes before judging the next activation.
    const token = (await until(snapshot, s => Boolean(s.actionToken), 'update controller ready')).actionToken;
    const act = action => fetch(url + '/api/plugin-update', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-DSH-Update-Token': token }, body: JSON.stringify({ action }) });
    await act('check');
    await until(snapshot, s => s.packageReady, 'download ready');
    assert.equal((await snapshot()).liveActivation, true);
    await act('install');
    await until(status, s => s.state === 'ready' && s.version === expected, 'hot activation');
    const final = await until(snapshot, s => s.lastResult === result, 'activation result');
    assert.equal(child.pid, pid); assert.equal(child.exitCode, null);
    assert.equal((await status()).url, url, '业务端口在热更新后仍可连接');
    return final;
  }
  const first = await update(versionAt(1), 'updated');
  assert.equal(first.progress.percent, 100);
  console.log('PASS: real DSH host applies verified local payload without restarting');
  await candidate(2);
  await update(versionAt(2), 'updated');
  console.log('PASS: repeated in-process update uses a fresh activation result');
  await candidate(3, true);
  const restored = await update(versionAt(2), 'restored');
  assert.equal(restored.candidateVersion, null);
  assert.equal(JSON.parse(readFileSync(resolve(dataDir, 'updates/slots.json'))).active.version, versionAt(2));
  console.log('PASS: unhealthy payload is unloaded and local previous payload resumes in the same DSH process');
} finally {
  if (child?.exitCode === null) {
    child.kill(); await Promise.race([new Promise(done => child.once('exit', done)), sleep(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (temp.startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/'))) rmSync(temp, { recursive: true, force: true });
}
