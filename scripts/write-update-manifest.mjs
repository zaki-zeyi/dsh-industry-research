import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const installCommit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(installCommit ?? '')) throw new Error('发布安装提交无效');

const release = JSON.parse(readFileSync('artifacts/plugin-release.json', 'utf8'));
const source = JSON.parse(readFileSync('package.json', 'utf8'));
if (release.version !== source.version || !/^[a-f0-9]{40}$/.test(release.sourceCommit)) {
  throw new Error('发布清单与源码版本不一致');
}
const installTag = process.argv[3];
if (installTag !== `plugin-install-v${source.version}`) throw new Error('安装版本标签无效');

const manifest = {
  schema: 'dsh-industry-research/update/v1',
  name: source.name,
  version: source.version,
  sourceCommit: release.sourceCommit,
  installCommit,
  installTag,
  archiveSha256: release.sha256,
};
writeFileSync(resolve('artifacts/update-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
