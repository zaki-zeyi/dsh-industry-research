import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createDshPluginIndex } from '../scripts/write-dsh-plugin-index.mjs';
import { publishIndex } from '../scripts/publish-dsh-plugin-index.mjs';

const installer = 'a'.repeat(40);
const source = 'b'.repeat(40);
const installTag = 'plugin-install-v0.13.16';
const published = '2026-11-26T03:30:22Z';
function fixture(manifestOverrides = {}) {
  const manifest = Buffer.from(JSON.stringify({
    schema: 'dsh-industry-research/update/v1', name: 'dsh-industry-research', version: '0.13.16',
    installTag, installCommit: installer, sourceCommit: source, ...manifestOverrides,
  }));
  return {
    manifest,
    release: { tag_name: 'v0.13.16', immutable: true, draft: false, prerelease: false, published_at: published,
      assets: [{ name: 'update-manifest.json', digest: 'sha256:' + createHash('sha256').update(manifest).digest('hex') }] },
    ref: { ref: `refs/tags/${installTag}`, object: { type: 'commit', sha: installer } },
  };
}

test('DSH Discover gets the verified installer commit, not a branch, tag or source commit', () => {
  const { release, manifest, ref } = fixture();
  const index = createDshPluginIndex(release, manifest, ref);
  assert.equal(index.format, 1);
  assert.equal(index.plugins[0].name, 'dsh-industry-research');
  assert.deepEqual(index.plugins[0].title, { zh: '行研工作台', en: 'Industry Research Workbench' });
  assert.deepEqual(index.plugins[0].versions, [{ version: '0.13.16', publishTimestamp: Date.parse(published) / 1000,
    source: { type: 'git', url: 'https://github.com/zaki-zeyi/dsh-industry-research', commit: installer } }]);
});

test('drafts, prereleases, mutable releases and invalid publication dates cannot replace the index', () => {
  const { release, manifest, ref } = fixture();
  for (const invalid of [{ draft: true }, { prerelease: true }, { immutable: false },
    { tag_name: 'v0.13.16-rc.1' }, { published_at: null }]) {
    assert.throws(() => createDshPluginIndex({ ...release, ...invalid }, manifest, ref), /immutable stable/);
  }
});

test('a mismatched manifest, moved installer tag or unpinned commit cannot replace the index', () => {
  const { release, manifest, ref } = fixture();
  assert.throws(() => createDshPluginIndex(release, Buffer.concat([manifest, Buffer.from('\n')]), ref), /does not match/);
  assert.throws(() => createDshPluginIndex(release, manifest, { ...ref, object: { type: 'commit', sha: source } }), /same plugin version and commit/);
  for (const invalid of [{ version: '0.13.15' }, { name: 'other-plugin' }, { installCommit: 'release' }]) {
    const candidate = fixture(invalid);
    assert.throws(() => createDshPluginIndex(candidate.release, candidate.manifest, ref), /same plugin version and commit/);
  }
});

test('index publication retries SHA conflicts and never overwrites a newer version', async () => {
  const f = fixture(); f.release.assets[0].browser_download_url = 'https://example.invalid/manifest';
  let reads = 0, writes = 0, currentVersion = '0.13.15';
  const api = async (path, options) => {
    if (path.startsWith('/releases/')) return f.release;
    if (path.startsWith('/git/')) return f.ref;
    if (!options) { reads++; return { sha: `sha-${reads}`, content: Buffer.from(JSON.stringify({ plugins: [{ name: 'dsh-industry-research', versions: [{ version: currentVersion }] }] })).toString('base64') }; }
    writes++; assert.equal(options.body.sha, `sha-${reads}`); assert.equal(options.body.branch, 'main');
    if (writes === 1) throw Object.assign(new Error('conflict'), { status: 409 });
    return { commit: { sha: 'published' } };
  };
  const result = await publishIndex('0.13.16', async () => new Response(f.manifest), api);
  assert.equal(result.changed, true); assert.equal(reads, 2); assert.equal(writes, 2);
  currentVersion = '0.13.17';
  assert.equal((await publishIndex('0.13.16', async () => new Response(f.manifest), api)).changed, false);
  assert.equal(writes, 2);
});

test('unverified release never starts an index write', async () => {
  const f = fixture(); f.release.immutable = false;
  f.release.assets[0].browser_download_url = 'https://example.invalid/manifest';
  await assert.rejects(publishIndex('0.13.16', async () => new Response(f.manifest), async path => {
    if (path.startsWith('/releases/')) return f.release;
    if (path.startsWith('/git/')) return f.ref;
    assert.fail('Index must not be accessed for an invalid release');
  }), /immutable/);
});
