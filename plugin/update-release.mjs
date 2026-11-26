import { createHash } from 'node:crypto';

export const packageName = 'dsh-industry-research';
export const repository = 'https://github.com/zaki-zeyi/dsh-industry-research.git';
const releaseUrl = 'https://api.github.com/repos/zaki-zeyi/dsh-industry-research/releases/latest';
const commitPattern = /^[a-f0-9]{40}$/;

export function newerVersion(candidate, installed) {
  const next = /^(\d+)\.(\d+)\.(\d+)$/.exec(candidate);
  const current = /^(\d+)\.(\d+)\.(\d+)$/.exec(installed);
  if (!next || !current) return false;
  for (let i = 1; i <= 3; i++) if (Number(next[i]) !== Number(current[i])) return Number(next[i]) > Number(current[i]);
  return false;
}

export async function readJson(response, maxBytes) {
  if (!response.ok) throw new Error(`更新服务返回 ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('更新清单过大');
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

// Both installation paths consume the same immutable, digest-verified release.
export async function readVerifiedRelease(request = fetch, currentVersion) {
  const { value: release } = await readJson(await request(releaseUrl, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': packageName }, signal: AbortSignal.timeout(15_000),
  }), 128 * 1024);
  if (currentVersion && /^v\d+\.\d+\.\d+$/.test(release.tag_name ?? '') && !newerVersion(release.tag_name.slice(1), currentVersion)) return null;
  if (release.immutable !== true) throw new Error('正式发布未启用不可变保护，已暂停自动更新');
  const asset = release.assets?.find(item => item.name === 'update-manifest.json');
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) throw new Error('正式发布缺少可校验的更新清单');
  const { bytes, value: manifest } = await readJson(await request(asset.browser_download_url, { signal: AbortSignal.timeout(15_000) }), 8 * 1024);
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error('更新清单校验失败');
  if (manifest.schema !== 'dsh-industry-research/update/v1' || manifest.name !== packageName ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) || release.tag_name !== `v${manifest.version}` ||
    !commitPattern.test(manifest.sourceCommit) || manifest.sourceCommit !== release.target_commitish ||
    !commitPattern.test(manifest.installCommit) || manifest.installTag !== `plugin-install-v${manifest.version}` ||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) || manifest.archiveName !== `${packageName}-${manifest.version}.tgz` ||
    !Number.isSafeInteger(manifest.archiveSize) || manifest.archiveSize < 1 || !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error('更新清单与正式发布不一致');
  }
  const archive = release.assets?.find(item => item.name === manifest.archiveName);
  if (!archive || archive.size !== manifest.archiveSize || archive.digest !== `sha256:${manifest.archiveSha256}`) throw new Error('正式发布安装包与更新清单不一致');
  return { version: manifest.version, installCommit: manifest.installCommit, publishedAt: release.published_at,
    archive: { version: manifest.version, name: manifest.archiveName, size: manifest.archiveSize,
      sha256: manifest.archiveSha256, url: archive.browser_download_url } };
}

export function trustedGitSource(source) {
  return /^(?:git\+)?https:\/\/github\.com\/zaki-zeyi\/dsh-industry-research(?:\.git)?#[a-f0-9]{40}$/i.test(source ?? '') ||
    /^github:zaki-zeyi\/dsh-industry-research#[a-f0-9]{40}$/i.test(source ?? '') ||
    /^(?:git\+ssh:\/\/git@github\.com\/|git@github\.com:)zaki-zeyi\/dsh-industry-research(?:\.git)?#[a-f0-9]{40}$/i.test(source ?? '');
}
