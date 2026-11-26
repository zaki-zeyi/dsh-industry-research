import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const name = 'dsh-industry-research';
const repo = `zaki-zeyi/${name}`;
const repository = `https://github.com/${repo}`;
const stableTag = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const commit = /^[a-f0-9]{40}$/;

export function createDshPluginIndex(release, manifestBytes, installerRef) {
  const version = stableTag.exec(release.tag_name)?.[1];
  const published = Date.parse(release.published_at);
  if (!version || release.immutable !== true || release.draft !== false || release.prerelease !== false ||
      !Number.isFinite(published) || published <= 0) {
    throw new Error('The DSH index requires a published, immutable stable GitHub release');
  }

  const digest = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`;
  if (!release.assets?.some(asset => asset.name === 'update-manifest.json' && asset.digest === digest)) {
    throw new Error('The update manifest does not match the immutable release asset');
  }
  const manifest = JSON.parse(manifestBytes);
  const installTag = `plugin-install-v${version}`;
  if (manifest.schema !== 'dsh-industry-research/update/v1' || manifest.name !== name || manifest.version !== version ||
      manifest.installTag !== installTag || !commit.test(manifest.installCommit ?? '') ||
      installerRef.ref !== `refs/tags/${installTag}` || installerRef.object?.type !== 'commit' ||
      installerRef.object.sha !== manifest.installCommit) {
    throw new Error('The update manifest and published installer tag do not identify the same plugin version and commit');
  }

  return {
    format: 1,
    title: { 'zh-cn': '行研工作台', en: 'Industry Research Workbench' },
    plugins: [{
      name,
      title: { 'zh-cn': '行研工作台', en: 'Industry Research Workbench' },
      description: { 'zh-cn': '公司信息库、专题调研与日报周报', en: 'Company research, topic reports and scheduled digests' },
      repository: { url: repository },
      versions: [{
        version,
        publishTimestamp: Math.floor(published / 1000),
        source: { type: 'git', url: repository, commit: manifest.installCommit },
      }],
    }],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gh = (path, ...options) => execFileSync('gh', ['api', `repos/${repo}/${path}`, ...options], { timeout: 30000 });
  const release = JSON.parse(gh('releases/latest'));
  const asset = release.assets?.find(asset => asset.name === 'update-manifest.json');
  if (!stableTag.test(release.tag_name) || !Number.isSafeInteger(asset?.id)) {
    throw new Error('The latest release is missing a stable tag or update manifest');
  }
  const manifest = gh(`releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream');
  const ref = JSON.parse(gh(`git/ref/tags/plugin-install-${release.tag_name}`));
  const index = createDshPluginIndex(release, manifest, ref);
  writeFileSync(new URL('../dsh-plugin-index.json', import.meta.url), JSON.stringify(index, null, 2) + '\n');
}
