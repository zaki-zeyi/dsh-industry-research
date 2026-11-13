import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const script = new URL('../scripts/publish-git-plugin.mjs', import.meta.url);
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} 失败：${result.stderr}`);
  return result.stdout.trim();
}
const git = (args, cwd) => run('git', args, cwd);
function gitInit(directory) {
  mkdirSync(directory, { recursive: true });
  git(['init', '-q', '--initial-branch', 'main'], directory);
  git(['config', 'user.name', 'release-fixture'], directory);
  git(['config', 'user.email', 'release-fixture@example.com'], directory);
}
function commitAll(cwd, message) {
  git(['add', '--all'], cwd);
  git(['commit', '-q', '-m', message], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}
// 与构建脚本同构的最小发布产物：安装清单 + 预构建页面 + 生产依赖。
function writeArtifacts(root, version) {
  const name = `dsh-industry-research-${version}`;
  const stage = resolve(root, 'artifacts', name);
  for (const directory of ['dist', 'plugin', 'node_modules/production-dependency']) mkdirSync(resolve(stage, directory), { recursive: true });
  writeFileSync(resolve(stage, 'dist/index.html'), '<script src="/assets/index-fixture.js"></script>');
  writeFileSync(resolve(stage, 'plugin/index.mjs'), 'export const fixture = true;\n');
  writeFileSync(resolve(stage, 'node_modules/production-dependency/index.js'), 'module.exports = 1;\n');
  writeFileSync(resolve(stage, 'package.json'), JSON.stringify({ name: 'dsh-industry-research', version, type: 'module', main: './plugin/index.mjs', dependencies: { 'production-dependency': '1.0.0' }, bundledDependencies: ['production-dependency'], files: ['plugin', 'dist'] }, null, 2));
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (const file of [`${name}.tgz`, `${name}-desktop.zip`]) writeFileSync(resolve(root, 'artifacts', file), `verified ${file}`);
  writeFileSync(resolve(root, 'artifacts/plugin-release.json'), JSON.stringify({ name: 'dsh-industry-research', version, directory: name, filename: `${name}.tgz`, sha256: hash(`verified ${name}.tgz`), zipFilename: `${name}-desktop.zip`, zipSha256: hash(`verified ${name}-desktop.zip`), sourceCommit: git(['rev-parse', 'HEAD'], root) }, null, 2));
}
// CI 的真实形态：发布作业在浅克隆、游离 HEAD 的 checkout 中运行，构建产物是未跟踪文件。
function shallowCheckout(bare, directory) {
  git(['clone', '-q', '--depth', '1', `file:///${bare.replaceAll('\\', '/')}`, directory], tmpdir());
  git(['checkout', '-q', '--detach', 'HEAD'], directory);
  git(['config', 'user.name', 'release-fixture'], directory);
  git(['config', 'user.email', 'release-fixture@example.com'], directory);
  return directory;
}
function publish(checkout, output) {
  const result = spawnSync(process.execPath, [resolve(checkout, 'scripts/publish-git-plugin.mjs'), '--output', output, '--push'], { cwd: checkout, encoding: 'utf8' });
  assert.equal(result.status, 0, `发布失败：${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}
function contract(workspace) {
  const bare = resolve(workspace, 'origin.git');
  const work = resolve(workspace, 'work');
  mkdirSync(bare);
  git(['init', '-q', '--bare', '--initial-branch', 'main'], bare);
  gitInit(work);
  writeFileSync(resolve(work, 'package.json'), JSON.stringify({ name: 'dsh-industry-research', version: '1.2.3' }, null, 2));
  writeFileSync(resolve(work, 'README.md'), '# 源码说明\n');
  writeFileSync(resolve(work, 'source.txt'), 'source\n');
  mkdirSync(resolve(work, 'scripts'), { recursive: true });
  cpSync(script, resolve(work, 'scripts/publish-git-plugin.mjs'));
  commitAll(work, 'main 首次提交');
  git(['remote', 'add', 'origin', bare], work);
  git(['push', '-q', 'origin', 'main'], work);
  return { bare, work };
}

test('release 分支与 main 共享历史，可以直接合并且保留源码与产物', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'release-branch-merge-'));
  const { bare, work } = contract(workspace);
  try {
    const firstCheckout = shallowCheckout(bare, resolve(workspace, 'checkout-1'));
    writeArtifacts(firstCheckout, '1.2.3');
    const firstSource = git(['rev-parse', 'HEAD'], firstCheckout);
    const first = publish(firstCheckout, resolve(workspace, 'output-1'));
    assert.equal(first.version, '1.2.3');
    assert.equal(first.sourceCommit, firstSource);
    const tree = () => git(['ls-tree', '-r', '--name-only', 'release'], bare).split('\n');
    assert.deepEqual(tree().sort(), ['README.md', 'dist/index.html', 'node_modules/production-dependency/index.js', 'package.json', 'plugin/index.mjs', 'scripts/publish-git-plugin.mjs', 'source.txt'].sort(), '安装分支 = 源码目录 + 验证产物，且不含未跟踪的 artifacts/');
    assert.equal(git(['rev-parse', 'release^'], bare), firstSource, '首次发布提交以源码提交为父提交');

    // 生产依赖里的原生辅助程序必须保留可执行位；Windows 上重新 add 会丢失该信息，发布脚本要沿用上一发布。
    const modeFix = resolve(workspace, 'mode-fix');
    git(['clone', '-q', bare, modeFix], workspace);
    git(['config', 'user.name', 'release-fixture'], modeFix);
    git(['config', 'user.email', 'release-fixture@example.com'], modeFix);
    git(['checkout', '-q', 'release'], modeFix);
    git(['update-index', '--chmod=+x', 'node_modules/production-dependency/index.js'], modeFix);
    git(['commit', '-q', '-m', 'fixture: mark helper executable'], modeFix);
    git(['push', '-q', 'origin', 'release'], modeFix);
    const releaseTip = git(['rev-parse', 'release'], bare);
    assert.match(git(['ls-tree', 'release', 'node_modules/production-dependency/index.js'], bare), /^100755 /);

    // main 推进但尚未发布：在 release 上合并 main 应当像普通分支一样干净通过（这正是原来做不到的事）。
    writeFileSync(resolve(work, 'source.txt'), 'source updated\n');
    writeFileSync(resolve(work, 'added-later.txt'), 'later\n');
    const secondSource = commitAll(work, 'main 后续提交');
    git(['push', '-q', 'origin', 'main'], work);
    const verify = resolve(workspace, 'verify');
    git(['clone', '-q', bare, verify], workspace);
    git(['config', 'user.name', 'release-fixture'], verify);
    git(['config', 'user.email', 'release-fixture@example.com'], verify);
    git(['checkout', '-q', 'release'], verify);
    assert.equal(git(['merge-base', 'main', 'release'], verify), firstSource, '两分支必须存在共同祖先');
    const merged = spawnSync('git', ['merge', '--no-edit', 'main'], { cwd: verify, encoding: 'utf8' });
    assert.equal(merged.status, 0, `合并 main 不应失败：${merged.stdout}${merged.stderr}`);
    assert.doesNotMatch(merged.stderr, /unrelated histories/);
    assert.equal(git(['status', '--porcelain'], verify), '', '合并后不应留下未解决内容');
    assert.equal(readFileSync(resolve(verify, 'source.txt'), 'utf8').replaceAll('\r\n', '\n'), 'source updated\n', '合并后源码更新到 main');
    assert.ok(existsSync(resolve(verify, 'added-later.txt')), '合并后获得 main 新增文件');
    assert.ok(existsSync(resolve(verify, 'dist/index.html')), '合并后仍保留预构建页面');
    assert.ok(existsSync(resolve(verify, 'node_modules/production-dependency/index.js')), '合并后仍保留生产依赖');
    assert.equal(JSON.parse(readFileSync(resolve(verify, 'package.json'), 'utf8')).scripts, undefined, '安装清单不得带生命周期脚本');

    // 版本号变更时只有安装清单（package.json）需要保留 release 侧内容，其余自动合并。
    writeFileSync(resolve(work, 'package.json'), JSON.stringify({ name: 'dsh-industry-research', version: '1.2.4' }, null, 2));
    const thirdSource = commitAll(work, 'main 版本号提升');
    git(['push', '-q', 'origin', 'main'], work);
    git(['fetch', '-q', 'origin'], verify);
    const bumped = spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd: verify, encoding: 'utf8' });
    assert.equal(bumped.status, 1, '安装清单必须阻止自动覆盖');
    assert.deepEqual(git(['diff', '--name-only', '--diff-filter=U'], verify).split('\n'), ['package.json'], '唯一冲突文件是安装清单');
    git(['checkout', '--ours', 'package.json'], verify);
    git(['add', 'package.json'], verify);
    git(['commit', '-q', '--no-edit'], verify);
    assert.equal(JSON.parse(readFileSync(resolve(verify, 'package.json'), 'utf8')).version, '1.2.3', '保留安装清单中的正式版本号');
    assert.equal(git(['status', '--porcelain'], verify), '');

    // 正式发布新的源码提交：安装分支同时记录上一发布与新源码提交。
    const secondCheckout = shallowCheckout(bare, resolve(workspace, 'checkout-2'));
    writeArtifacts(secondCheckout, '1.2.4');
    const second = publish(secondCheckout, resolve(workspace, 'output-2'));
    assert.equal(second.version, '1.2.4');
    assert.equal(second.sourceCommit, thirdSource);
    const parents = git(['rev-list', '--parents', '-n', '1', 'release'], bare).split(' ');
    assert.equal(parents.length, 3, '再次发布应同时记录上一发布与源码提交');
    assert.deepEqual(parents.slice(1), [releaseTip, thirdSource]);
    assert.ok(tree().includes('added-later.txt'), '安装分支必须包含最新源码');
    assert.ok(tree().includes('node_modules/production-dependency/index.js'), '安装分支必须包含生产依赖');
    assert.match(git(['ls-tree', 'release', 'node_modules/production-dependency/index.js'], bare), /^100755 /, '发布脚本必须沿用生产依赖的可执行位');
    assert.equal(git(['merge-base', 'main', 'release'], bare), thirdSource, '合并基点跟进到最新源码提交');
    assert.equal(secondSource, git(['rev-parse', 'main~1'], bare));
    const fresh = resolve(workspace, 'verify-2');
    git(['clone', '-q', bare, fresh], workspace);
    git(['config', 'user.name', 'release-fixture'], fresh);
    git(['config', 'user.email', 'release-fixture@example.com'], fresh);
    git(['checkout', '-q', 'release'], fresh);
    const upToDate = spawnSync('git', ['merge', '--no-edit', 'main'], { cwd: fresh, encoding: 'utf8' });
    assert.equal(upToDate.status, 0);
    assert.match(upToDate.stdout, /Already up to date/, '最新源码已并入安装分支');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('发布产物来自其他提交时拒绝写入安装分支', () => {
  const workspace = mkdtempSync(resolve(tmpdir(), 'release-branch-source-'));
  const { bare } = contract(workspace);
  try {
    const checkout = shallowCheckout(bare, resolve(workspace, 'checkout'));
    writeArtifacts(checkout, '1.2.3');
    const release = JSON.parse(readFileSync(resolve(checkout, 'artifacts/plugin-release.json'), 'utf8'));
    writeFileSync(resolve(checkout, 'artifacts/plugin-release.json'), JSON.stringify({ ...release, sourceCommit: '0'.repeat(40) }, null, 2));
    const result = spawnSync(process.execPath, [resolve(checkout, 'scripts/publish-git-plugin.mjs'), '--output', resolve(workspace, 'output'), '--push'], { cwd: checkout, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /不一致/);
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'refs/heads/release'], { cwd: bare, encoding: 'utf8' }).status, 0, '拒绝时不得创建安装分支');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
