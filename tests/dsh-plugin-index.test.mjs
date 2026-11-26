import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createDshPluginIndex } from '../scripts/write-dsh-plugin-index.mjs';

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
