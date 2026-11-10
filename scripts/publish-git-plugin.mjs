import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const output = arg('--output');
if (!output || existsSync(output)) throw new Error('请用 --output 指定新的临时发布目录');
const directory = resolve(output), release = JSON.parse(readFileSync(resolve(root, 'artifacts/plugin-release.json')));
const branch = 'release';
const source = JSON.parse(readFileSync(resolve(root, 'package.json')));
assert.equal(release.version, source.version, 'Rebuild artifacts after changing the source version');
for (const [file, hash] of [[release.filename, release.sha256], [release.zipFilename, release.zipSha256]]) {
 assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'artifacts', file))).digest('hex'), hash, 'Release artifact checksum mismatch');
}
assert.equal(JSON.parse(readFileSync(resolve(root, 'artifacts', release.directory, 'package.json'))).version, source.version);
function git(args, cwd = directory, allowFailure = false) {
 const r = spawnSync('git', args, { cwd, timeout: 120000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
 if (!allowFailure && (r.error || r.status !== 0)) throw r.error ?? new Error(`git ${args[0]} 失败：${r.stderr}`);
 return r;
}
const remote = git(['remote', 'get-url', 'origin'], root).stdout.trim();
mkdirSync(directory, { recursive: true }); git(['init', '--initial-branch', branch]); git(['remote', 'add', 'origin', remote]);
for (const key of ['user.name', 'user.email']) { const value = git(['config', key], root).stdout.trim(); if (!value) throw new Error('请先配置 Git 提交身份'); git(['config', key, value]); }
if (process.argv.includes('--push')) {
 const existing = git(['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/' + branch], directory, true);
 if (existing.status === 0) { git(['fetch', '--depth', '1', 'origin', branch]); git(['checkout', '-B', branch, 'FETCH_HEAD']); }
 else if (existing.status !== 2) throw new Error('无法检查已有安装分支，请检查 GitHub 授权和网络');
}
for (const name of readdirSync(directory)) if (name !== '.git') rmSync(resolve(directory, name), { recursive: true, force: true });
cpSync(resolve(root, 'artifacts', release.directory), directory, { recursive: true });
cpSync(resolve(root, 'README.md'), resolve(directory, 'README.md'));
const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json')));
if (manifest.name !== 'dsh-industry-research' || manifest.scripts) throw new Error('安装分支必须使用无生命周期脚本的正式发布包');
git(['add', '--force', '--all']);
if (git(['diff', '--cached', '--quiet'], directory, true).status !== 0) git(['commit', '-m', `Publish ${manifest.name} ${manifest.version} installer`]);
if (process.argv.includes('--push')) git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
console.log(JSON.stringify({ branch, version: manifest.version, directory, commit: git(['rev-parse', 'HEAD']).stdout.trim(), pushed: process.argv.includes('--push') }));
