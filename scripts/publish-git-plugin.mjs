import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const output = arg('--output');
if (!output || existsSync(output)) throw new Error('请用 --output 指定新的临时发布目录');
const directory = resolve(output);
// 安装分支与 main 共用一条历史：提交内容 = 源码提交的完整目录 + 经 CI 验证的安装包。
// 因此 `git merge main` 可以在 release 上直接完成，不再出现 unrelated histories。
const sourceDirectory = resolve(arg('--source-dir') ?? root);
const branch = 'release';
const release = JSON.parse(readFileSync(resolve(root, 'artifacts/plugin-release.json')));
const source = JSON.parse(readFileSync(resolve(root, 'package.json')));
assert.equal(release.version, source.version, 'Rebuild artifacts after changing the source version');
for (const [file, hash] of [[release.filename, release.sha256], [release.zipFilename, release.zipSha256]]) {
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'artifacts', file))).digest('hex'), hash, 'Release artifact checksum mismatch');
}
assert.equal(JSON.parse(readFileSync(resolve(root, 'artifacts', release.directory, 'package.json'))).version, source.version);
function git(args, cwd = directory, allowFailure = false) {
  // 安装目录必须与验证过的产物逐字节一致，不能让换行转换改写内容。
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], { cwd, timeout: 120000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (!allowFailure && (r.error || r.status !== 0)) throw r.error ?? new Error(`git ${args[0]} 失败：${r.stderr}`);
  return r;
}
const value = (args, cwd) => git(args, cwd).stdout.trim();
// 发布产物必须来自将要记录为父提交的源码提交，否则安装分支会指向错误的版本。
const sourceCommit = value(['rev-parse', 'HEAD'], sourceDirectory);
if (release.sourceCommit && release.sourceCommit !== sourceCommit) throw new Error(`发布产物来自 ${release.sourceCommit}，与源码 ${sourceCommit} 不一致`);
const remote = value(['remote', 'get-url', 'origin'], root);
const push = process.argv.includes('--push');
mkdirSync(directory, { recursive: true });
git(['init', '--initial-branch', branch]);
git(['remote', 'add', 'origin', remote]);
for (const key of ['user.name', 'user.email']) {
  const configured = git(['config', key], sourceDirectory, true).stdout.trim();
  if (!configured) throw new Error('请先配置 Git 提交身份');
  git(['config', key, configured]);
}
let previous = null;
if (push) {
  const existing = git(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], directory, true);
  if (existing.status === 0) { git(['fetch', '--depth', '1', 'origin', branch]); previous = value(['rev-parse', 'FETCH_HEAD']); }
  else if (existing.status !== 2) throw new Error('无法检查已有安装分支，请检查 GitHub 授权和网络');
}
// 以 ref 而不是 SHA 从产出该安装包的源码目录取提交，浅克隆（CI 的 checkout）同样可用。
git(['fetch', '--depth', '1', sourceDirectory, 'HEAD:refs/source/head']);
assert.equal(value(['rev-parse', 'refs/source/head']), sourceCommit, '无法从源码目录取得产出该安装包的提交');
git(['read-tree', 'refs/source/head']);
// 工作流的创建/修改需要 workflow 权限，发布用的内置凭据没有该权限；安装分支因此不镜像 .github。
git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '.github']);
git(['checkout-index', '-a', '-f']);
cpSync(resolve(root, 'artifacts', release.directory), directory, { recursive: true });
// 安装包里的 README 是用户安装说明，分支根目录仍保留源码 README；从索引取回可避免工作树换行差异改写内容。
git(['checkout-index', '-f', '--', 'README.md']);
const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json')));
assert.deepEqual(manifest, source, '安装产物必须使用原始源码清单，请重新构建');
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'publish']) {
  assert.ok(!manifest.scripts?.[hook], `发布包不得带生命周期脚本：${hook}`);
}
// 从源码索引恢复原始字节（含换行），两分支的包清单不再产生任何分叉。
git(['checkout-index', '-f', '--', 'package.json']);
git(['add', '--force', '--all']);
// 生产依赖的可执行位（如 node-pty 的 spawn-helper）在 Windows 上无法从文件系统读回，沿用上一发布的记录。
if (previous) {
  for (const line of git(['ls-tree', '-r', previous]).stdout.split('\n')) {
    if (line.startsWith('100755 ')) git(['update-index', '--chmod=+x', '--', line.slice(line.indexOf('\t') + 1)], directory, true);
  }
}
const tree = value(['write-tree']);
const message = `Publish ${manifest.name} ${manifest.version} installer from ${sourceCommit.slice(0, 12)}`;
let commit = previous;
if (previous === null) commit = value(['commit-tree', tree, '-p', 'refs/source/head', '-m', message]);
else if (value(['rev-parse', `${previous}^{tree}`]) !== tree) commit = value(['commit-tree', tree, '-p', previous, '-p', 'refs/source/head', '-m', message]);
const changed = commit !== previous;
git(['update-ref', `refs/heads/${branch}`, commit]);
git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
if (push && changed) git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
console.log(JSON.stringify({ branch, version: manifest.version, sourceCommit, directory, commit, changed, pushed: push }));
