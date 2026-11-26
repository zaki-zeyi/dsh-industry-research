import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDshPluginIndex } from './write-dsh-plugin-index.mjs';
import { newerVersion } from '../plugin/update-release.mjs';

// Publish only a verified immutable release. The contents API's expected SHA
// preserves unrelated main changes and makes concurrent edits retryable.
export async function publishIndex(version, request, api) {
  const release = await api(`/releases/tags/v${version}`);
  const asset = release.assets?.find(item => item.name === 'update-manifest.json');
  if (!asset?.browser_download_url) throw new Error('Published update manifest missing');
  const response = await request(asset.browser_download_url);
  if (!response.ok) throw new Error(`Update manifest: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const ref = await api(`/git/ref/tags/plugin-install-v${version}`);
  const index = createDshPluginIndex(release, bytes, ref);
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await api('/contents/dsh-plugin-index.json?ref=main');
    const current = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    const previous = current.plugins?.find(item => item.name === 'dsh-industry-research')?.versions?.[0]?.version;
    if (newerVersion(previous, version) || JSON.stringify(current) === JSON.stringify(index)) return { changed: false, version: previous };
    try {
      const result = await api('/contents/dsh-plugin-index.json', { method: 'PUT', body: {
        branch: 'main', sha: file.sha, message: `Publish DSH plugin index for ${version}`,
        content: Buffer.from(JSON.stringify(index, null, 2) + '\n').toString('base64'),
      } });
      return { changed: true, version, commit: result.commit.sha };
    } catch (error) { if (error.status !== 409 || attempt === 2) throw error; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (!process.env.GH_TOKEN) throw new Error('GH_TOKEN is required');
  const api = async (path, options = {}) => {
    const response = await fetch(`https://api.github.com/repos/zaki-zeyi/dsh-industry-research${path}`, {
      method: options.method ?? 'GET', headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'User-Agent': 'dsh-industry-research-release' },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub index publication: HTTP ${response.status}`), { status: response.status });
    return response.json();
  };
  console.log(JSON.stringify(await publishIndex(version, (url) => fetch(url, { signal: AbortSignal.timeout(30_000) }), api)));
}
