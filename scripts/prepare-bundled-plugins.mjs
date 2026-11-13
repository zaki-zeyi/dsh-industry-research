import { createHash } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm-command.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputRoot = resolve(root, 'artifacts/bundled-plugins');
const cacheDir = resolve(outputRoot, '.cache');
const manifest = JSON.parse(readFileSync(resolve(root, 'installer/windows/bundled-plugins.json'), 'utf8'));
const force = process.argv.includes('--force');

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) fail(`${command} 执行失败：${result.error?.message ?? result.status}`);
}

function slugFor(name) {
  return name.replace(/^@/, '').replaceAll('/', '-');
}

function dependencyName(spec) {
  if (spec.startsWith('@')) return spec.slice(0, spec.indexOf('@', 1));
  return spec.split('@')[0];
}

function sha256File(filename) {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function directoryBytes(directory) {
  if (!existsSync(directory)) return 0;
  return statSync(directory).isDirectory()
    ? readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => total + directoryBytes(join(directory, entry.name)), 0)
    : statSync(directory).size;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) fail(`下载失败 ${response.status}：${url}`);
  mkdirSync(resolve(destination, '..'), { recursive: true });
  await new Promise((resolveStream, reject) => {
    const stream = createWriteStream(destination);
    Readable.fromWeb(response.body).pipe(stream);
    stream.on('finish', resolveStream);
    stream.on('error', reject);
  });
}

function isPrepared(plugin, target) {
  if (force) return false;
  const packageFile = join(target, 'package.json');
  if (!existsSync(packageFile)) return false;
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
  if (packageJson.name !== plugin.name || packageJson.version !== plugin.version) return false;
  if (!packageJson.dsh?.bundle?.patch) return false;
  for (const spec of plugin.additionalDependencies ?? []) {
    if (!existsSync(join(target, 'node_modules', dependencyName(spec)))) return false;
  }
  return true;
}

function installNpm(target, specs = []) {
  const args = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'];
  if (!specs.length) {
    const npm = npmCommand(args);
    run(npm.command, npm.args, { cwd: target });
    return;
  }
  const peer = join(target, '.peer-install');
  rmSync(peer, { recursive: true, force: true });
  mkdirSync(peer, { recursive: true });
  try {
    const npm = npmCommand([...args, '--prefix', peer, ...specs]);
    run(npm.command, npm.args, { cwd: target });
    mkdirSync(join(target, 'node_modules'), { recursive: true });
    cpSync(join(peer, 'node_modules'), join(target, 'node_modules'), { recursive: true, force: true });
  } finally {
    rmSync(peer, { recursive: true, force: true });
  }
}

async function prepare(plugin) {
  const slug = slugFor(plugin.name);
  const target = join(outputRoot, slug, plugin.version);
  if (isPrepared(plugin, target)) {
    console.log(`复用 ${plugin.name}@${plugin.version}`);
    return metadata(plugin, slug, target, true);
  }

  rmSync(target, { recursive: true, force: true });
  mkdirSync(resolve(target, '..'), { recursive: true });
  const archive = join(cacheDir, basename(new URL(plugin.sourceUrl).pathname));
  if (!existsSync(archive) || sha256File(archive).toLowerCase() !== plugin.sha256.toLowerCase()) {
    console.log(`下载 ${plugin.name}@${plugin.version}`);
    await download(plugin.sourceUrl, archive);
  }
  const actualSha256 = sha256File(archive);
  if (actualSha256.toLowerCase() !== plugin.sha256.toLowerCase()) fail(`${plugin.name} SHA256 不匹配`);

  const temporary = join(outputRoot, `.extract-${slug}`);
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    run('tar', ['-xzf', archive, '-C', temporary]);
    const extracted = join(temporary, 'package');
    if (!existsSync(join(extracted, 'package.json'))) fail(`${plugin.name} 安装包缺少 package.json`);
    cpSync(extracted, target, { recursive: true, force: true });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  const packageJson = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  if (packageJson.name !== plugin.name || packageJson.version !== plugin.version) fail(`${plugin.name} 包元信息与固定清单不一致`);
  if (!packageJson.dsh?.bundle?.patch) fail(`${plugin.name} 不是可预装的 DSH bundle 插件`);
  if (packageJson.dependencies && Object.keys(packageJson.dependencies).length) installNpm(target);
  if (plugin.additionalDependencies?.length) installNpm(target, plugin.additionalDependencies);
  return metadata(plugin, slug, target, false);
}

function metadata(plugin, slug, target, reused) {
  return {
    name: plugin.name,
    version: plugin.version,
    slug,
    license: plugin.license,
    homepage: plugin.homepage,
    sourceUrl: plugin.sourceUrl,
    sha256: plugin.sha256,
    sourceBytes: statSync(join(cacheDir, basename(new URL(plugin.sourceUrl).pathname))).size,
    installedBytes: directoryBytes(target),
    reused,
  };
}

mkdirSync(outputRoot, { recursive: true });
mkdirSync(cacheDir, { recursive: true });
const prepared = [];
for (const plugin of manifest.plugins) prepared.push(await prepare(plugin));
writeFileSync(resolve(outputRoot, 'manifest.json'), JSON.stringify({ schemaVersion: 1, plugins: prepared, preparedAt: new Date().toISOString() }, null, 2) + '\n');
for (const plugin of prepared) console.log(`已准备 ${plugin.name}@${plugin.version}`);
